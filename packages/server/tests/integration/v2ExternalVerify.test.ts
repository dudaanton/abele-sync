import { copyFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUser } from '../../src/access/tokens.js'
import { v2Server, type V2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { V2EngineClient } from '@abele/sync-core'
import { V2ExternalFilesCapabilitiesSchema } from '@abele/sync-protocol'

const headers = { 'x-abele-external-files-version': '1' }
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`v2 external verification (${dialect})`, () => {
    let server: V2Server
    afterEach(async () => {
      vi.restoreAllMocks()
      await server?.close()
    })
    async function setup(group = false) {
      server = await v2Server(dialect)
      const root = await createUser(
        { db: server.db, pepper: server.config.tokenPepper, dialect },
        'Owner',
        server.address
      )
      const owner = new V2SyncClient(root.token)
      const selector = group
        ? await owner.create('Root.md', 'root')
        : (await owner.commit([{ op: 'mkdir', path: 'Shared' }])).results[0]!
      if (selector.status === 'rejected') throw new Error(selector.message)
      const share = await owner.json('/tokens', 'POST', {
        scope: { kind: group ? 'group' : 'folder', id: selector.file_id },
        label: 'Share',
      })
      const guest = new V2SyncClient(share.token)
      const file = group
        ? (
            await guest.json(
              '/group-assets',
              'POST',
              {
                path: 'Shared/a.bin',
                ...(await guest.upload(Buffer.from('attachment'))),
                mtime: 1000,
              },
              { 'idempotency-key': 'publish' }
            )
          ).results[0]
        : await owner.create('Shared/a.bin', 'attachment')
      if (file.status === 'rejected') throw new Error(file.message)
      const expected = {
        version_id: file.version_id,
        path: file.path,
        sha: file.sha,
        size: file.size,
      }
      const path = `/files/${file.file_id}/external/verify`
      return {
        owner,
        guest,
        file,
        expected,
        path,
        share,
        client: new V2EngineClient(share.token, { fetch }),
      }
    }
    for (const group of [false, true])
      it(`actual v2 core client negotiates token capabilities and verifies live ${group ? 'group' : 'folder'} head, never a private earlier version`, async () => {
        const f = await setup(group)
        const capability = V2ExternalFilesCapabilitiesSchema.parse(
          await f.guest.json('/external-files/capabilities')
        )
        expect(capability.token).toBe(true)
        expect(capability.verification.authorization_rechecked).toBe(true)
        expect(await f.client.externalFilesCapabilities()).toEqual(capability)
        expect(await f.client.head(f.file.file_id)).toMatchObject({
          file_id: f.file.file_id,
          ...f.expected,
        })
        expect(await f.client.verifyExternalFile(f.file.file_id, f.expected)).toEqual({
          verified: true,
          file_id: f.file.file_id,
          ...f.expected,
        })
        const response = await f.guest.request(f.path, 'POST', f.expected, headers)
        expect(response.headers.get('cache-control')).toBe('no-store')
        const privateFile = await f.owner.create('Private.bin', 'private')
        if (privateFile.status === 'rejected') throw new Error(privateFile.message)
        await expect(f.client.head(privateFile.file_id)).rejects.toMatchObject({
          code: 'not_found',
        })
        await expect(
          f.client.verifyExternalFile(privateFile.file_id, {
            version_id: privateFile.version_id,
            path: privateFile.path,
            sha: privateFile.sha!,
            size: privateFile.size,
          })
        ).rejects.toMatchObject({ code: 'not_found' })
      })
    it('negotiates the space size ceiling and does not verify bytes above it', async () => {
      const f = await setup()
      const row = await server.db
        .selectFrom('spaces')
        .select(['id', 'settings'])
        .executeTakeFirstOrThrow()
      const settings = JSON.parse(row.settings)
      settings.max_file_bytes = 5
      await server.db
        .updateTable('spaces')
        .set({ settings: JSON.stringify(settings) })
        .where('id', '=', row.id)
        .execute()
      expect((await f.client.externalFilesCapabilities()).max_file_size).toBe(5)
      await expect(f.client.verifyExternalFile(f.file.file_id, f.expected)).rejects.toMatchObject({
        code: 'too_large',
      })
    })
    it('requires exact version header; malformed and noncanonical expectations are rejected', async () => {
      const f = await setup()
      for (const version of [undefined, '0', '2', '01', '1,1']) {
        const bad: Record<string, string> =
          version === undefined ? {} : { 'x-abele-external-files-version': version }
        expect((await f.guest.request(f.path, 'POST', f.expected, bad)).status).toBe(400)
        expect(
          (await f.guest.request(`/files/${f.file.file_id}/head`, 'GET', undefined, bad)).status
        ).toBe(400)
      }
      for (const patch of [
        { size: -1 },
        { size: 0.5 },
        { size: 200 * 1024 * 1024 + 1 },
        { version_id: '' },
        { sha: 'INVALID' },
        { unexpected: true },
        { path: '../a.bin' },
      ])
        expect(
          (await f.guest.request(f.path, 'POST', { ...f.expected, ...patch }, headers)).status
        ).toBe(400)
      for (const patch of [
        { path: 'Shared/wrong.bin' },
        { version_id: 'unknown' },
        { sha: 'a'.repeat(64) },
        { size: 11 },
      ])
        expect(
          (await f.guest.request(f.path, 'POST', { ...f.expected, ...patch }, headers)).status
        ).toBe(404)
    })
    for (const damage of [
      'missing',
      'corrupt',
      'wrong-envelope',
      'metadata-length',
      'missing-ref',
    ] as const)
      it(`refuses ${damage}, not just matching scope/SQL metadata`, async () => {
        const f = await setup()
        await f.client.verifyExternalFile(f.file.file_id, f.expected)
        const path = server.store.pathFor(f.expected.sha)
        if (damage === 'missing') await server.store.delete(f.expected.sha)
        if (damage === 'corrupt') await writeFile(path, 'not an authenticated envelope')
        if (damage === 'wrong-envelope') {
          const other = await server.store.put(Buffer.from('wrong bytes'))
          await copyFile(server.store.pathFor(other.sha), path)
        }
        if (damage === 'metadata-length') {
          f.expected.size++
          await server.db
            .updateTable('versions')
            .set({ size: f.expected.size })
            .where('id', '=', f.file.version_id)
            .execute()
          await server.db
            .updateTable('blobs')
            .set({ size: f.expected.size })
            .where('sha', '=', f.expected.sha)
            .execute()
        }
        if (damage === 'missing-ref')
          await server.db
            .updateTable('blobs')
            .set({ refs: 0 })
            .where('sha', '=', f.expected.sha)
            .execute()
        await expect(f.client.verifyExternalFile(f.file.file_id, f.expected)).rejects.toMatchObject(
          { code: 'not_found' }
        )
      })
    it('stale, moved, departed, deleted and revoked heads cannot authorize eviction or cached verification', async () => {
      const f = await setup()
      const changed = (
        await f.owner.commit([
          {
            op: 'modify',
            file_id: f.file.file_id,
            base_version_id: f.file.version_id,
            ...(await f.owner.upload(Buffer.from('changed'))),
            mtime: 2000,
          },
        ])
      ).results[0]!
      if (changed.status === 'rejected') throw new Error(changed.message)
      await expect(f.client.verifyExternalFile(f.file.file_id, f.expected)).rejects.toMatchObject({
        code: 'not_found',
      })
      const current = {
        version_id: changed.version_id,
        path: changed.path,
        sha: changed.sha!,
        size: changed.size,
      }
      await f.client.verifyExternalFile(f.file.file_id, current)
      const moved = (
        await f.owner.commit([
          {
            op: 'move',
            file_id: f.file.file_id,
            base_version_id: changed.version_id,
            to_path: 'Private/Secret.bin',
          },
        ])
      ).results[0]!
      if (moved.status === 'rejected') throw new Error(moved.message)
      await expect(f.client.head(f.file.file_id)).rejects.toMatchObject({ code: 'not_found' })
      await expect(f.client.verifyExternalFile(f.file.file_id, current)).rejects.toMatchObject({
        code: 'not_found',
      })
      await f.owner.commit([
        { op: 'delete', file_id: f.file.file_id, base_version_id: moved.version_id },
      ])
      await expect(f.client.verifyExternalFile(f.file.file_id, current)).rejects.toMatchObject({
        code: 'not_found',
      })
      await f.owner.json('/tokens/' + f.share.info.id, 'DELETE')
      await expect(f.client.externalFilesCapabilities()).rejects.toMatchObject({
        code: 'unauthorized',
      })
    })
    it('verification serializes with scope changes/revocation and never answers from a cached success', async () => {
      const f = await setup()
      const actual = server.store.verify.bind(server.store)
      let arrived!: () => void, release!: () => void
      const entered = new Promise<void>((r) => {
        arrived = r
      })
      const gate = new Promise<void>((r) => {
        release = r
      })
      vi.spyOn(server.store, 'verify').mockImplementationOnce(async (sha) => {
        const result = await actual(sha)
        arrived()
        await gate
        return result
      })
      const verifying = f.client.verifyExternalFile(f.file.file_id, f.expected)
      try {
        await entered
        const revoked = f.owner.json('/tokens/' + f.share.info.id, 'DELETE')
        release()
        expect((await verifying).verified).toBe(true)
        await revoked
        await expect(f.client.verifyExternalFile(f.file.file_id, f.expected)).rejects.toMatchObject(
          { code: 'unauthorized' }
        )
      } finally {
        release()
        await verifying.catch(() => {})
      }
    })
    it.skipIf(dialect !== 'pg')(
      'final authority recheck refuses a token disabled outside the API during blob verification',
      async () => {
        const f = await setup()
        const actual = server.store.verify.bind(server.store)
        let arrived!: () => void, release!: () => void
        const entered = new Promise<void>((r) => {
            arrived = r
          }),
          gate = new Promise<void>((r) => {
            release = r
          })
        vi.spyOn(server.store, 'verify').mockImplementationOnce(async (sha) => {
          const result = await actual(sha)
          arrived()
          await gate
          return result
        })
        const verifying = f.client.verifyExternalFile(f.file.file_id, f.expected)
        // Observe the rejection immediately: do not let an expected denial become unhandled.
        const denial = expect(verifying).rejects.toMatchObject({ code: 'unauthorized' })
        try {
          await entered
          await server.db
            .updateTable('access_tokens')
            .set({ revoked_at: new Date().toISOString() })
            .where('id', '=', f.share.info.id)
            .execute()
          release()
          await denial
        } finally {
          release()
          await verifying.catch(() => {})
        }
      }
    )
  })
}
