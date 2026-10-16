import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'
import { runMigrations } from '../../src/db/migrate.js'
import WebSocket from 'ws'
import { deleteFolder } from '../../src/access/deleteFolder.js'
import { V2DeleteScopeResponseSchema } from '@abele/sync-protocol'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(dialect, () => {
    it('backfills existing token-space names without changing owner identity', async () => {
      const t = await tempDb(dialect, (db, schema) => runMigrations(db, schema, '005_groups'))
      try {
        const at = new Date().toISOString()
        await t.db
          .insertInto('users')
          .values({ id: 'owner', label: 'Existing owner', created_at: at, disabled_at: null })
          .execute()
        await t.db
          .insertInto('spaces')
          .values({
            id: 'space',
            user_id: 'owner',
            address: 'https://sync.example',
            settings: '{}',
            created_at: at,
          })
          .execute()
        await runMigrations(t.db, t.schema)
        await runMigrations(t.db, t.schema)
        expect(await t.db.selectFrom('spaces').selectAll().executeTakeFirstOrThrow()).toMatchObject(
          { id: 'space', user_id: 'owner', name: 'Existing owner', deleted_at: null }
        )
      } finally {
        await t.close()
      }
    })
    it('operator deletion trashes a subtree, revokes its tokens and refuses reuploads', async () => {
      const f = await tokenFixture(dialect)
      try {
        const file = success(await f.root.create('Agents/sub/a.md', 'hello'))
        await f.root.create('AgentsExtra/keep.md', 'keep')
        const nested = (await f.root.manifest()).items.find((i) => i.path === 'Agents/sub')!
        const nestedShare = await f.root.share(nested.file_id)
        const group = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'group', id: file.file_id },
          label: 'Group inside deleted folder',
        })
        const socket = new WebSocket(f.t.address.replace('http:', 'ws:') + '/v2/events', {
          headers: { authorization: 'Bearer ' + f.guest.key },
        })
        const frames: unknown[] = []
        socket.on('message', (data) => frames.push(JSON.parse(data.toString())))
        await new Promise<void>((resolve, reject) => {
          socket.once('message', () => resolve())
          socket.once('error', reject)
        })
        const closed = new Promise<number>((resolve) =>
          socket.once('close', (code) => resolve(code))
        )
        expect((await f.guest.request('/folders/delete', 'POST', { path: 'Agents' })).status).toBe(
          404
        )
        await expect(
          deleteFolder({ ...f.t, pepper: f.t.config.tokenPepper }, f.space, '/', {
            kind: 'system',
            id: 'operator',
            name: 'operator',
          })
        ).rejects.toThrow()
        const response = V2DeleteScopeResponseSchema.parse(
          await deleteFolder({ ...f.t, pepper: f.t.config.tokenPepper }, f.space, 'Agents', {
            kind: 'system',
            id: 'operator',
            name: 'operator',
          })
        )
        expect(response.revoked_tokens).toContain(f.share.info.id)
        expect(response.revoked_tokens).toContain(nestedShare.info.id)
        expect(response.revoked_tokens).toContain(group.info.id)
        expect(await closed).toBe(4004)
        expect(frames).toContainEqual({ type: 'connection', status: 'scope_deleted' })
        expect(JSON.stringify(await f.root.json('/trash'))).toContain(file.file_id)
        expect(JSON.stringify(await f.root.changes())).toContain('delete')
        expect((await f.guest.request('/manifest')).status).toBe(401)
        expect(
          (await f.guest.request('/folders/delete', 'POST', { path: 'AgentsExtra' })).status
        ).toBe(401)
        expect(
          (
            await f.guest.request(
              '/commit',
              'POST',
              { ops: [{ op: 'mkdir', path: 'resurrect' }] },
              { 'idempotency-key': 'revoked' }
            )
          ).status
        ).toBe(401)
        expect((await f.root.manifest()).items.some((i) => i.path === 'AgentsExtra/keep.md')).toBe(
          true
        )
        expect(
          await f.t.db
            .selectFrom('audit')
            .selectAll()
            .where('action', '=', 'folder.delete')
            .execute()
        ).toHaveLength(1)
      } finally {
        await f.close()
      }
    })
  })
