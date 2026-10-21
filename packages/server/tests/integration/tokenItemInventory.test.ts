import { describe, expect, it } from 'vitest'
import { V2ScopeItemsResponseSchema } from '@abele/sync-protocol'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { createUser } from '../../src/access/tokens.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`issued item inventory (${dialect})`, () => {
    it('counts live implicit and explicit items only when the client requests counts', async () => {
      const f = await tokenFixture(dialect)
      const headers = { 'abele-client-capabilities': 'token-item-count' }
      const count = async () =>
        (await f.root.json('/tokens', 'GET', undefined, headers)).items.find(
          (token: { id: string }) => token.id === f.share.info.id
        ).item_count
      try {
        expect(await count()).toBe(1)
        const file = success(await f.root.create('other.md', 'other'))
        const item = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: file.file_id },
        })
        expect(await count()).toBe(2)
        await f.root.json(`/tokens/${f.share.info.id}/items/primary:${f.share.info.id}`, 'DELETE')
        expect(await count()).toBe(1)
        await f.root.json(`/tokens/${f.share.info.id}/items/${item.id}`, 'DELETE')
        expect(await count()).toBe(0)
        expect(
          (await f.root.json('/tokens')).items.find(
            (token: { id: string }) => token.id === f.share.info.id
          )
        ).not.toHaveProperty('item_count')
      } finally {
        await f.close()
      }
    })
    it('returns the same implicit legacy item as the holder without materializing it', async () => {
      const f = await tokenFixture(dialect)
      try {
        const holder = V2ScopeItemsResponseSchema.parse(await f.guest.json('/connection/items'))
        expect(holder.items).toHaveLength(1)
        expect(holder.items[0]!.id).toBe(`primary:${f.share.info.id}`)
        expect(await f.root.json(`/tokens/${f.share.info.id}/items`)).toEqual(holder)
        expect(await f.t.db.selectFrom('access_token_items').selectAll().execute()).toEqual([])
      } finally {
        await f.close()
      }
    })

    it('lets the direct issuer and whole-vault key read all items and their removed state', async () => {
      const f = await tokenFixture(dialect)
      try {
        const nested = success(
          (await f.root.commit([{ op: 'mkdir', path: 'Agents/Nested' }])).results[0]!
        )
        const child = await f.guest.share(nested.file_id)
        const holder = new V2SyncClient(child.token)
        const file = success(await f.root.create('outside.md', 'outside'))
        const group = success(await f.root.create('Agents/group.md', 'group'))
        const added = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: file.file_id },
        })
        await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
          scope: { kind: 'group', id: group.file_id },
        })
        const before = V2ScopeItemsResponseSchema.parse(await holder.json('/connection/items'))
        expect(before.items.map((item) => item.scope.kind).sort()).toEqual([
          'file',
          'folder',
          'group',
        ])
        // The issuer can manage the child key, but the added outside file is
        // outside its content authority and must not appear in its inventory.
        expect(await f.guest.json(`/tokens/${child.info.id}/items`)).toEqual({
          items: before.items.filter((item) => item.id !== added.id),
        })
        expect(await f.root.json(`/tokens/${child.info.id}/items`)).toEqual(before)
        await f.root.json(`/tokens/${child.info.id}/items/${added.id}`, 'DELETE')
        const after = V2ScopeItemsResponseSchema.parse(await holder.json('/connection/items'))
        expect(after.items.find((item) => item.id === added.id)).toMatchObject({
          removed_at: expect.any(String),
          scope: { path: '(unavailable)' },
        })
        expect(await f.guest.json(`/tokens/${child.info.id}/items`)).toEqual({
          items: after.items.filter((item) => item.id !== added.id),
        })
        expect(await f.root.json(`/tokens/${child.info.id}/items`)).toEqual(after)
      } finally {
        await f.close()
      }
    })

    it('refuses siblings, non-owner holders, unknown IDs and other vaults', async () => {
      const f = await tokenFixture(dialect)
      try {
        const sibling = await f.root.share(f.share.info.scope.id)
        expect((await f.guest.request(`/tokens/${sibling.info.id}/items`)).status).toBe(403)
        expect((await f.guest.request(`/tokens/${f.share.info.id}/items`)).status).toBe(403)
        expect((await f.root.request('/tokens/unknown/items')).status).toBe(403)
        const other = await createUser(
          { db: f.t.db, pepper: f.t.config.tokenPepper },
          'Other',
          f.t.address
        )
        const foreign = new V2SyncClient(other.token)
        const foreignId = (await foreign.json('/connection')).token_id
        expect((await f.root.request(`/tokens/${foreignId}/items`)).status).toBe(403)
        expect((await foreign.request(`/tokens/${f.share.info.id}/items`)).status).toBe(403)
      } finally {
        await f.close()
      }
    })
  })
