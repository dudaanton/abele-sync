import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { v2Server } from '../helpers/v2Server.js'
import { createUser } from '../../src/access/tokens.js'
import { purgeVault } from '../../src/access/vaultLifecycle.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`item review regressions (${dialect})`, () => {
    it('uses the issuer selected item to authorize a different token item deletion', async () => {
      const f = await tokenFixture(dialect)
      try {
        const folder = success((await f.root.commit([{ op: 'mkdir', path: 'B' }])).results[0]!)
        success(await f.root.create('B/delete.md', 'delete'))
        const child = await f.guest.share(f.share.info.scope.id)
        const scope = { kind: 'folder', id: folder.file_id }
        const callerItem = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', { scope })
        const targetItem = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', { scope })
        expect(callerItem.id).not.toBe(targetItem.id)
        const result = await f.guest.json(
          `/connection/items/${targetItem.id}/delete`,
          'POST',
          {},
          {
            'abele-scope-item': callerItem.id,
            'idempotency-key': randomUUID(),
          }
        )
        expect(result.files).toBe(1)
        expect(result.revoked_tokens).not.toContain(f.share.info.id)
        expect(result.revoked_tokens).not.toContain(child.info.id)
        const rows = await f.t.db.selectFrom('access_token_items').selectAll().execute()
        expect(rows.find((row) => row.id === callerItem.id)?.removed_at).toBeNull()
        expect(rows.find((row) => row.id === targetItem.id)?.removed_at).toEqual(expect.any(String))
        expect((await f.guest.request('/connection')).status).toBe(200)
      } finally {
        await f.close()
      }
    })
    it('checks every group member before an issuer can delete the item', async () => {
      const f = await tokenFixture(dialect)
      try {
        const group = success(await f.root.create('Agents/G.md', 'G'))
        const member = success(
          await f.root.create('Outside.md', '---\ngroups: ["[[Agents/G]]"]\n---\nprivate')
        )
        const child = await f.guest.share(f.share.info.scope.id)
        const item = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
          scope: { kind: 'group', id: group.file_id },
        })
        expect(
          (
            await f.guest.request(
              `/connection/items/${item.id}/delete`,
              'POST',
              {},
              { 'idempotency-key': randomUUID() }
            )
          ).status
        ).toBe(403)
        expect((await f.root.content(group.file_id)).toString()).toBe('G')
        expect((await f.root.content(member.file_id)).toString()).toContain('private')
      } finally {
        await f.close()
      }
    })
    it('requires the issuer to have its own live content authority before deleting an added item', async () => {
      const f = await tokenFixture(dialect)
      try {
        const b = success((await f.root.commit([{ op: 'mkdir', path: 'B' }])).results[0]!)
        const file = success(await f.root.create('B/keep.md', 'keep'))
        const child = await f.guest.share(f.share.info.scope.id)
        const item = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
          scope: { kind: 'folder', id: b.file_id },
        })
        const path = `/connection/items/${item.id}/delete`
        const request = () => f.guest.request(path, 'POST', {}, { 'idempotency-key': randomUUID() })
        expect((await request()).status).toBe(403)
        expect((await f.root.content(file.file_id)).toString()).toBe('keep')
        const own = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'folder', id: b.file_id },
        })
        await f.root.json(`/tokens/${f.share.info.id}/items/${own.id}`, 'DELETE')
        expect((await request()).status).toBe(403)
        const live = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'folder', id: b.file_id },
        })
        // Naming A explicitly must not use the key's other B item.
        const denied = await f.guest.request(
          path,
          'POST',
          {},
          { 'idempotency-key': randomUUID(), 'abele-scope-item': `primary:${f.share.info.id}` }
        )
        expect(denied.status).toBe(403)
        expect(await denied.json()).toMatchObject({
          error: {
            code: 'forbidden',
            message: 'item deletion requires the caller’s own live content authority',
          },
        })
        expect(live.id).toBeTruthy()
        const deleted = await request()
        expect(deleted.status).toBe(200)
        expect(await deleted.json()).toMatchObject({ files: 1 })
      } finally {
        await f.close()
      }
    })

    for (const configurationRoot of ['.obsidian', 'Settings']) {
      it(`keeps file items out of inherited configuration paths (${configurationRoot})`, async () => {
        const t = await v2Server(dialect, { configurationDirectories: ['Settings'] })
        try {
          const root = new V2SyncClient(
            (
              await createUser(
                { db: t.db, pepper: t.config.tokenPepper, dialect },
                'Owner',
                t.address
              )
            ).token
          )
          const folder = success((await root.commit([{ op: 'mkdir', path: 'A' }])).results[0]!)
          const file = success(await root.create('A/secret.md', 'before'))
          const a = new V2SyncClient((await root.share(folder.file_id)).token)
          const fileKey = await a.json('/tokens', 'POST', {
            scope: { kind: 'file', id: file.file_id },
            label: 'File',
          })
          const reader = new V2SyncClient(fileKey.token)
          expect((await reader.content(file.file_id)).toString()).toBe('before')
          success(
            (
              await root.commit([
                {
                  op: 'move_directory',
                  file_id: folder.file_id,
                  base_version_id: folder.version_id,
                  to_path: `${configurationRoot}/A`,
                },
              ])
            ).results[0]!
          )
          expect((await a.request(`/files/${file.file_id}/content`)).status).toBe(404)
          expect((await reader.request(`/files/${file.file_id}/content`)).status).toBe(404)
          const head = (await root.manifest()).items.find((i) => i.file_id === file.file_id)!
          const newer = success(
            (
              await root.commit([
                {
                  op: 'modify',
                  file_id: file.file_id,
                  base_version_id: head.version_id,
                  ...(await root.upload(Buffer.from('private update'))),
                  mtime: 2000,
                },
              ])
            ).results[0]!
          )
          expect((await reader.manifest()).items).toEqual([])
          expect(
            (await reader.request(`/files/${file.file_id}/content?version_id=${newer.version_id}`))
              .status
          ).toBe(404)
          expect(
            (await reader.changes()).items.some(
              (event) => event.type === 'content' && event.item.version_id === newer.version_id
            )
          ).toBe(false)
        } finally {
          await t.close()
        }
      })
    }

    it.each(['live', 'removed', 'implicit'] as const)(
      'purges token item foreign keys (%s)',
      async (state) => {
        const f = await tokenFixture(dialect)
        try {
          const file = success(await f.root.create('outside.md', 'bytes'))
          if (state === 'implicit') {
            await f.root.json(
              `/tokens/${f.share.info.id}/items/primary:${f.share.info.id}`,
              'DELETE'
            )
          } else {
            const item = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
              scope: { kind: 'file', id: file.file_id },
            })
            if (state === 'removed')
              await f.root.json(`/tokens/${f.share.info.id}/items/${item.id}`, 'DELETE')
          }
          expect(await f.t.db.selectFrom('access_token_items').selectAll().execute()).toHaveLength(
            1
          )
          const other = await createUser(
            { db: f.t.db, pepper: f.t.config.tokenPepper, dialect },
            'Other',
            f.t.address
          )
          await expect(
            f.t.db.transaction().execute((trx) => purgeVault(trx, f.space))
          ).resolves.toBeGreaterThan(0)
          expect(await f.t.db.selectFrom('access_token_items').selectAll().execute()).toEqual([])
          expect(
            await f.t.db
              .selectFrom('access_tokens')
              .select('id')
              .where('space_id', '=', f.space)
              .execute()
          ).toEqual([])
          expect(
            (await f.t.db.selectFrom('access_tokens').select('id').execute()).map((row) => row.id)
          ).toContain(other.info.id)
        } finally {
          await f.close()
        }
      }
    )

    it('refreshes a file projection on inherited group reentry without backfilling private versions', async () => {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('G.md', 'G'))
        const membership = '---\ngroups: ["[[G]]"]\n---\nM'
        const m = success(await f.root.create('M.md', membership))
        const text = '---\ngroups: ["[[M]]"]\n---\n'
        const file = success(await f.root.create('F.md', text + 'before'))
        const groupKey = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'group', id: g.file_id },
          label: 'G',
        })
        const group = new V2SyncClient(groupKey.token)
        const fileKey = await group.json('/tokens', 'POST', {
          scope: { kind: 'file', id: file.file_id },
          label: 'F',
        })
        const reader = new V2SyncClient(fileKey.token)
        const before = await reader.changes()
        const removed = success(
          (
            await f.root.commit([
              {
                op: 'modify',
                file_id: m.file_id,
                base_version_id: m.version_id,
                ...(await f.root.upload(Buffer.from('M'))),
                mtime: 2000,
              },
            ])
          ).results[0]!
        )
        expect((await reader.request('/manifest')).status).toBe(503)
        const hidden = success(
          (
            await f.root.commit([
              {
                op: 'modify',
                file_id: file.file_id,
                base_version_id: file.version_id,
                ...(await f.root.upload(Buffer.from(text + 'hidden intermediate'))),
                mtime: 3000,
              },
            ])
          ).results[0]!
        )
        const current = success(
          (
            await f.root.commit([
              {
                op: 'modify',
                file_id: file.file_id,
                base_version_id: hidden.version_id,
                ...(await f.root.upload(Buffer.from(text + 'current'))),
                mtime: 4000,
              },
            ])
          ).results[0]!
        )
        // A caller may have observed this vault cursor through another item.
        const watermark = (await f.root.changes()).cursor
        success(
          (
            await f.root.commit([
              {
                op: 'modify',
                file_id: m.file_id,
                base_version_id: removed.version_id,
                ...(await f.root.upload(Buffer.from(membership))),
                mtime: 5000,
              },
            ])
          ).results[0]!
        )
        expect((await reader.json('/connection')).status).toBe('active')
        expect((await reader.manifest()).items).toContainEqual(
          expect.objectContaining({ file_id: file.file_id, version_id: current.version_id })
        )
        expect((await reader.content(file.file_id)).toString()).toBe(text + 'current')
        const events = (await reader.changes(watermark)).items
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'content',
            file_id: file.file_id,
            item: expect.objectContaining({ version_id: current.version_id }),
          })
        )
        expect(
          (await reader.changes(before.cursor)).items.some(
            (event) => event.type === 'content' && event.item.version_id === hidden.version_id
          )
        ).toBe(false)
        expect(
          (await reader.request(`/files/${file.file_id}/content?version_id=${hidden.version_id}`))
            .status
        ).toBe(404)
        const caughtUp = (await reader.changes()).cursor
        success(await f.root.create('Unrelated.md', 'unrelated'))
        expect((await reader.changes(caughtUp)).items).toEqual([])
      } finally {
        await f.close()
      }
    })
  })
}
