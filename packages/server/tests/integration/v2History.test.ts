import { afterEach, describe, expect, it } from 'vitest'
import { createUser } from '../../src/access/tokens.js'
import { v2Server, type V2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`v2 history (${dialect})`, () => {
    let server: V2Server
    afterEach(async () => {
      await server?.close()
    })
    async function setup() {
      server = await v2Server(dialect)
      const root = await createUser(
        { db: server.db, pepper: server.config.tokenPepper, dialect },
        'Owner',
        server.address
      )
      const owner = new V2SyncClient(root.token)
      const dir = (await owner.commit([{ op: 'mkdir', path: 'Shared' }])).results[0]!
      if (dir.status === 'rejected') throw new Error(dir.message)
      const share = await owner.share(dir.file_id)
      return { owner, guest: new V2SyncClient(share.token), share }
    }
    it('filters private earlier versions before paging; departures cannot read or restore; trash is scoped and restore replays safely', async () => {
      const { owner, guest, share } = await setup()
      const privateFile = await owner.create('Private.md', 'private earlier')
      if (privateFile.status === 'rejected') throw new Error(privateFile.message)
      const visible = (
        await owner.commit([
          {
            op: 'move',
            file_id: privateFile.file_id,
            base_version_id: privateFile.version_id,
            to_path: 'Shared/Note.md',
          },
        ])
      ).results[0]!
      if (visible.status === 'rejected') throw new Error(visible.message)
      const history = await guest.json(`/files/${visible.file_id}/history?limit=1`)
      expect(history).toHaveLength(1)
      expect(history[0].version_id).toBe(visible.version_id)
      expect(await guest.json(`/files/${visible.file_id}/history?before=${history[0].no}`)).toEqual(
        []
      )
      expect(JSON.stringify(history)).not.toContain('Private.md')
      expect(
        (
          await guest.json(
            `/files/${visible.file_id}/restore`,
            'POST',
            { version_id: privateFile.version_id },
            { 'idempotency-key': 'private' }
          )
        ).status
      ).toBe('rejected')
      await owner.create('Other.md', 'other private')
      await guest.commit([
        { op: 'delete', file_id: visible.file_id, base_version_id: visible.version_id },
      ])
      expect((await guest.content(visible.file_id, visible.version_id)).toString()).toBe(
        'private earlier'
      )
      await expect(guest.content(visible.file_id, privateFile.version_id)).rejects.toMatchObject({
        status: 404,
      })
      expect((await guest.json('/trash')).map((i: { file_id: string }) => i.file_id)).toEqual([
        visible.file_id,
      ])
      expect(
        (await guest.json(`/files/${visible.file_id}/history`)).map(
          (i: { version_id: string }) => i.version_id
        )
      ).not.toContain(privateFile.version_id)
      const restore = () =>
        guest.json(
          `/files/${visible.file_id}/restore`,
          'POST',
          { deleted: true },
          { 'idempotency-key': 'restore' }
        )
      const result = await restore()
      expect(result.status).toBe('applied')
      expect(await restore()).toEqual(result)
      expect((await guest.content(visible.file_id)).toString()).toBe('private earlier')
      if (result.status === 'rejected') throw new Error('restore rejected')
      await owner.commit([
        {
          op: 'move',
          file_id: result.file_id,
          base_version_id: result.version_id,
          to_path: 'SecretDestination.md',
        },
      ])
      await expect(guest.json(`/files/${result.file_id}/history`)).rejects.toMatchObject({
        status: 404,
      })
      expect(
        (
          await guest.json(
            `/files/${result.file_id}/restore`,
            'POST',
            { version_id: visible.version_id },
            { 'idempotency-key': 'departed' }
          )
        ).status
      ).toBe('rejected')
      await owner.json('/tokens/' + share.info.id, 'DELETE')
      await expect(restore()).rejects.toMatchObject({ status: 401 })
    })
    it('bulk restore picks under the lock, returns one result per requested file and rejects changed idempotent payloads', async () => {
      const { owner, guest } = await setup()
      const file = await owner.create('Shared/A.md', 'a')
      if (file.status === 'rejected') throw new Error(file.message)
      await guest.commit([
        { op: 'delete', file_id: file.file_id, base_version_id: file.version_id },
      ])
      const request = { file_ids: [file.file_id, 'unknown'] }
      const restore = () =>
        guest.json('/trash/restore', 'POST', request, { 'idempotency-key': 'bulk' })
      const first = await restore()
      expect(first.results.map((r: { status: string }) => r.status)).toEqual([
        'applied',
        'rejected',
      ])
      expect(await restore()).toEqual(first)
      await expect(
        guest.json(
          '/trash/restore',
          'POST',
          { file_ids: ['unknown'] },
          { 'idempotency-key': 'bulk' }
        )
      ).rejects.toMatchObject({ code: 'idempotency_mismatch' })
      expect(
        (
          await guest.json('/trash/restore', 'POST', request, { 'idempotency-key': 'new-bulk' })
        ).results.every((r: { status: string }) => r.status === 'rejected')
      ).toBe(true)
    })
  })
}
