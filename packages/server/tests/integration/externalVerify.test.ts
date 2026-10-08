import { copyFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

const headers = { 'x-abele-external-files-version': '1', 'x-abele-scoped-version': '4' }
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `external live-head verification (${dialect})`,
    () => {
      async function fixture() {
        const f = await scopedFixture(dialect, true)
        await putBlob(f.t.app, f.device.deviceToken, 'attachment')
        const file = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/a.bin', 'attachment'),
          ])
        ).results[0]!
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const reader = await f.issue('reader', 'reader')
        const expected = {
          version_id: file.version_id,
          path: file.path,
          sha: shaOf('attachment'),
          size: 10,
        }
        return { ...f, file, reader, expected }
      }
      type F = Awaited<ReturnType<typeof fixture>>
      const url = (f: F, mode: 'personal' | 'scoped', file = f.file.file_id) =>
        mode === 'personal'
          ? `/v1/vaults/${f.vault}/files/${file}/external/verify`
          : `/v1/scoped/vaults/${f.vault}/grants/${f.grant.id}/files/${file}/external/verify`
      const token = (f: F, mode: 'personal' | 'scoped') =>
        mode === 'personal' ? f.device.deviceToken : f.reader.key_token

      it('BUG: advertises a separate complete extension without altering strict legacy capabilities', async () => {
        const f = await fixture()
        try {
          const old = await api(f.t.app).get('/v1/capabilities')
          expect(Object.keys(old.body).sort()).toEqual(['device', 'protocol_version', 'scoped'])
          const res = await api(f.t.app).get('/v1/external-files/capabilities')
          expect(res.status).toBe(200)
          expect(res.headers['cache-control']).toBe('no-store')
          expect(res.body).toEqual({
            extension_version: 1,
            projection_schema: 1,
            personal: true,
            scoped: true,
            verification: {
              live_head: true,
              sha256: true,
              actual_size: true,
              authorization_rechecked: true,
            },
            max_file_size: 200 * 1024 * 1024,
          })
        } finally {
          await f.close()
        }
      })
      it('BUG: personal head is live metadata, version-gated and vault-bound', async () => {
        const f = await fixture()
        try {
          const path = `/v1/vaults/${f.vault}/files/${f.file.file_id}/head`
          expect((await api(f.t.app, f.device.deviceToken).get(path)).status).toBe(400)
          const res = await api(f.t.app, f.device.deviceToken).get(path, headers)
          expect(res.status).toBe(200)
          expect(res.body).toMatchObject({ file_id: f.file.file_id, ...f.expected })
          expect((await api(f.t.app, f.reader.key_token).get(path, headers)).status).toBe(401)
          expect(
            (await api(f.t.app, f.device.deviceToken).get(path.replace(f.vault, 'other'), headers))
              .status
          ).toBe(403)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            { op: 'delete', file_id: f.file.file_id, base_version_id: f.file.version_id },
          ])
          expect((await api(f.t.app, f.device.deviceToken).get(path, headers)).status).toBe(404)
        } finally {
          await f.close()
        }
      })
      for (const mode of ['personal', 'scoped'] as const) {
        it(`BUG: valid ${mode} reader verification passes and requires exact version headers`, async () => {
          const f = await fixture()
          try {
            const client = api(f.t.app, token(f, mode)),
              path = url(f, mode)
            const res = await client.post(path, f.expected, headers)
            expect(res.status).toBe(200)
            expect(res.body).toEqual({ verified: true, file_id: f.file.file_id, ...f.expected })
            expect(res.headers['cache-control']).toBe('no-store')
            for (const version of [undefined, '0', '2', '01', '1,1']) {
              const h = {
                'x-abele-scoped-version': '4',
                ...(version === undefined ? {} : { 'x-abele-external-files-version': version }),
              }
              expect((await client.post(path, f.expected, h)).status).toBe(400)
            }
            if (mode === 'scoped')
              expect(
                (await client.post(path, f.expected, { 'x-abele-external-files-version': '1' }))
                  .status
              ).toBe(400)
          } finally {
            await f.close()
          }
        })
        it(`BUG: ${mode} denies wrong identity/path/version/SHA/size and unauthorized facets`, async () => {
          const f = await fixture()
          try {
            for (const patch of [
              { path: 'Agents/wrong.bin' },
              { version_id: 'unknown' },
              { sha: 'a'.repeat(64) },
              { size: 11 },
            ]) {
              expect(
                (
                  await api(f.t.app, token(f, mode)).post(
                    url(f, mode),
                    { ...f.expected, ...patch },
                    headers
                  )
                ).status
              ).toBe(404)
            }
            expect(
              (
                await api(f.t.app, token(f, mode)).post(
                  url(f, mode, 'unknown'),
                  f.expected,
                  headers
                )
              ).status
            ).toBe(404)
            await putBlob(f.t.app, f.device.deviceToken, 'another')
            const other = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                create('Private/b.bin', 'another'),
              ])
            ).results[0]!
            expect(
              (
                await api(f.t.app, token(f, mode)).post(
                  url(f, mode),
                  { ...f.expected, version_id: other.version_id },
                  headers
                )
              ).status
            ).toBe(404)
            for (const bad of [
              undefined,
              f.owner.accountToken,
              mode === 'scoped' ? f.device.deviceToken : f.reader.key_token,
            ])
              expect((await api(f.t.app, bad).post(url(f, mode), f.expected, headers)).status).toBe(
                401
              )
            if (mode === 'scoped') {
              expect(
                (
                  await api(f.t.app, f.reader.key_token).post(
                    url(f, mode, other.file_id),
                    {
                      version_id: other.version_id,
                      path: other.path,
                      sha: shaOf('another'),
                      size: 7,
                    },
                    headers
                  )
                ).status
              ).toBe(404)
              expect(
                (
                  await api(f.t.app, f.reader.key_token).post(
                    url(f, mode).replace(f.grant.id, 'other'),
                    f.expected,
                    headers
                  )
                ).status
              ).toBe(401)
            }
          } finally {
            await f.close()
          }
        })
        for (const damage of ['missing', 'corrupt', 'wrong-envelope', 'metadata-length'] as const)
          it(`BUG: ${mode} refuses ${damage}, not just matching SQL metadata`, async () => {
            const f = await fixture()
            try {
              expect(
                (await api(f.t.app, token(f, mode)).post(url(f, mode), f.expected, headers)).status
              ).toBe(200)
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
                  .updateTable('scope_current_members')
                  .set({ size: f.expected.size })
                  .where('file_id', '=', f.file.file_id)
                  .execute()
                await f.t.db
                  .updateTable('blobs')
                  .set({ size: f.expected.size })
                  .where('sha', '=', f.expected.sha)
                  .execute()
              }
              expect(
                (await api(f.t.app, token(f, mode)).post(url(f, mode), f.expected, headers)).status
              ).toBe(404)
            } finally {
              await f.close()
            }
          })
        it(`BUG: ${mode} rejects deleted and stale admitted heads even if old bytes still exist`, async () => {
          const f = await fixture()
          try {
            expect(
              (await api(f.t.app, token(f, mode)).post(url(f, mode), f.expected, headers)).status
            ).toBe(200)
            const oldMember = await f.t.db
              .selectFrom('scope_current_members')
              .selectAll()
              .where('file_id', '=', f.file.file_id)
              .executeTakeFirstOrThrow()
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
            // Simulate lag/corruption in the materialized scoped view: admission alone is not live-head proof.
            await f.t.db
              .updateTable('scope_current_members')
              .set(oldMember)
              .where('file_id', '=', f.file.file_id)
              .execute()
            expect(
              (await api(f.t.app, token(f, mode)).post(url(f, mode), f.expected, headers)).status
            ).toBe(404)
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              { op: 'delete', file_id: f.file.file_id, base_version_id: edited.version_id },
            ])
            expect(
              (await api(f.t.app, token(f, mode)).post(url(f, mode), f.expected, headers)).status
            ).toBe(404)
          } finally {
            await f.close()
          }
        })
      }
    }
  )
}
