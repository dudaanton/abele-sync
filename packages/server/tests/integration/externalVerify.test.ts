import { copyFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp } from '../helpers/testApp.js'

const headers = { 'x-abele-external-files-version': '1' }
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `retained external verification engine (${dialect})`,
    () => {
      async function fixture() {
        const t = await buildTestApp({ dialect })
        const owner = await t.account(),
          vault = (await t.vault(owner.accountToken)).vaultId
        const device = await t.device(owner.accountToken, vault)
        await putBlob(t.app, device.deviceToken, 'attachment')
        const file = (
          await commit(t.app, device.deviceToken, vault, [create('Assets/a.bin', 'attachment')])
        ).results[0]!
        const expected = {
          version_id: file.version_id,
          path: file.path,
          sha: shaOf('attachment'),
          size: 10,
        }
        const client = api(t.app, device.deviceToken)
        const path = `/v1/vaults/${vault}/files/${file.file_id}/external/verify`
        return { t, owner, vault, device, file, expected, client, path }
      }
      it('personal head is live metadata, version-gated and vault-bound', async () => {
        const f = await fixture()
        try {
          const path = `/v1/vaults/${f.vault}/files/${f.file.file_id}/head`
          expect((await f.client.get(path)).status).toBe(400)
          expect((await f.client.get(path, headers)).body).toMatchObject({
            file_id: f.file.file_id,
            ...f.expected,
          })
          expect((await f.client.get(path.replace(f.vault, 'other'), headers)).status).toBe(403)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            { op: 'delete', file_id: f.file.file_id, base_version_id: f.file.version_id },
          ])
          expect((await f.client.get(path, headers)).status).toBe(404)
        } finally {
          await f.t.close()
        }
      })
      it('retains the configured size ceiling', async () => {
        const t = await buildTestApp({ dialect, maxFileBytes: 1024 })
        try {
          expect((await api(t.app).get('/v1/external-files/capabilities')).body).toMatchObject({
            max_file_size: 1024,
          })
        } finally {
          await t.close()
        }
      })
      it('valid verification requires exact version headers', async () => {
        const f = await fixture()
        try {
          const response = await f.client.post(f.path, f.expected, headers)
          expect(response.status).toBe(200)
          expect(response.body).toEqual({ verified: true, file_id: f.file.file_id, ...f.expected })
          expect(response.headers['cache-control']).toBe('no-store')
          for (const version of [undefined, '0', '2', '01', '1,1'])
            expect(
              (
                await f.client.post(
                  f.path,
                  f.expected,
                  version === undefined ? {} : { 'x-abele-external-files-version': version }
                )
              ).status
            ).toBe(400)
        } finally {
          await f.t.close()
        }
      })
      it('rejects malformed, oversized and noncanonical expectations', async () => {
        const f = await fixture()
        try {
          for (const patch of [
            { size: -1 },
            { size: 0.5 },
            { size: 200 * 1024 * 1024 + 1 },
            { version_id: '' },
            { sha: 'INVALID' },
            { unexpected: true },
            { path: '../a.bin' },
          ])
            expect((await f.client.post(f.path, { ...f.expected, ...patch }, headers)).status).toBe(
              400
            )
        } finally {
          await f.t.close()
        }
      })
      it('denies wrong identity/path/version/SHA/size and unauthorized requests', async () => {
        const f = await fixture()
        try {
          for (const patch of [
            { path: 'Assets/wrong.bin' },
            { version_id: 'unknown' },
            { sha: 'a'.repeat(64) },
            { size: 11 },
          ])
            expect((await f.client.post(f.path, { ...f.expected, ...patch }, headers)).status).toBe(
              404
            )
          expect(
            (await f.client.post(f.path.replace(f.file.file_id, 'unknown'), f.expected, headers))
              .status
          ).toBe(404)
          await putBlob(f.t.app, f.device.deviceToken, 'another')
          const other = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Private/b.bin', 'another'),
            ])
          ).results[0]!
          expect(
            (await f.client.post(f.path, { ...f.expected, version_id: other.version_id }, headers))
              .status
          ).toBe(404)
          for (const bad of [undefined, f.owner.accountToken])
            expect((await api(f.t.app, bad).post(f.path, f.expected, headers)).status).toBe(401)
        } finally {
          await f.t.close()
        }
      })
      for (const damage of ['missing', 'corrupt', 'wrong-envelope', 'metadata-length'] as const)
        it(`refuses ${damage}, not just matching SQL metadata`, async () => {
          const f = await fixture()
          try {
            expect((await f.client.post(f.path, f.expected, headers)).status).toBe(200)
            const path = f.t.store.pathFor(f.expected.sha)
            if (damage === 'missing') await f.t.store.delete(f.expected.sha)
            if (damage === 'corrupt') await writeFile(path, 'not an authenticated envelope')
            if (damage === 'wrong-envelope') {
              const other = await f.t.store.put(Buffer.from('wrong bytes'))
              await copyFile(f.t.store.pathFor(other.sha), path)
            }
            if (damage === 'metadata-length') {
              f.expected.size++
              await f.t.db
                .updateTable('versions')
                .set({ size: f.expected.size })
                .where('id', '=', f.file.version_id)
                .execute()
              await f.t.db
                .updateTable('blobs')
                .set({ size: f.expected.size })
                .where('sha', '=', f.expected.sha)
                .execute()
            }
            expect((await f.client.post(f.path, f.expected, headers)).status).toBe(404)
          } finally {
            await f.t.close()
          }
        })
      it('rejects deleted and stale heads even if old bytes still exist', async () => {
        const f = await fixture()
        try {
          expect((await f.client.post(f.path, f.expected, headers)).status).toBe(200)
          await putBlob(f.t.app, f.device.deviceToken, 'changed')
          const edited = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'modify',
                file_id: f.file.file_id,
                base_version_id: f.file.version_id,
                sha: shaOf('changed'),
                size: 7,
                mtime: 2,
              },
            ])
          ).results[0]!
          expect((await f.client.post(f.path, f.expected, headers)).status).toBe(404)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            { op: 'delete', file_id: f.file.file_id, base_version_id: edited.version_id },
          ])
          expect((await f.client.post(f.path, f.expected, headers)).status).toBe(404)
        } finally {
          await f.t.close()
        }
      })
    }
  )
