import { describe, expect, it } from 'vitest'
import { V2ItemContentPreviewSchema, V2TokenContentPreviewSchema } from '@abele/sync-protocol'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { createUser } from '../../src/access/tokens.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`owner content previews (${dialect})`, () => {
    it('caps overlap details while reporting the exact number of covering items', async () => {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('Agents/G.md', 'G'))
        const issue = () =>
          f.root.json('/tokens', 'POST', { scope: { kind: 'group', id: g.file_id }, label: 'G' })
        const target = await issue()
        for (let i = 0; i < 21; i++) await issue()
        const preview = V2ItemContentPreviewSchema.parse(
          await f.root.json(`/tokens/${target.info.id}/items/primary:${target.info.id}/preview`)
        )
        expect(preview.files).toHaveLength(1)
        expect(preview.files[0]!.overlap_count).toBe(23)
        expect(preview.files[0]!.overlaps).toHaveLength(20)
      } finally {
        await f.close()
      }
    })
    it('previews an implicit legacy item with capped paths and full byte/file totals without changing content', async () => {
      const f = await tokenFixture(dialect)
      try {
        await f.root.create('Agents/a.md', 'hello')
        await f.root.create('Agents/b.md', 'world!')
        await f.root.create('private.md', 'private')
        const before = await f.guest.manifest()
        const path = `/tokens/${f.share.info.id}/items/primary:${f.share.info.id}/preview`
        const item = V2ItemContentPreviewSchema.parse(await f.root.json(path + '?limit=1'))
        expect(item).toMatchObject({
          id: `primary:${f.share.info.id}`,
          status: 'active',
          file_count: 2,
          total_bytes: 11,
          files: [{ path: 'Agents/a.md', bytes: 5, overlaps: [], overlap_count: 0 }],
        })
        expect(item.files).toHaveLength(1)
        expect(
          V2TokenContentPreviewSchema.parse(
            await f.root.json(`/tokens/${f.share.info.id}/preview?limit=1`)
          )
        ).toMatchObject({
          token_id: f.share.info.id,
          file_count: 2,
          total_bytes: 11,
          items: [item],
        })
        expect(await f.guest.manifest()).toEqual(before)
        expect(await f.t.db.selectFrom('access_token_items').selectAll().execute()).toEqual([])
        expect((await f.root.request(path + '?limit=501')).status).toBe(400)
      } finally {
        await f.close()
      }
    })

    it('tracks group membership and overlap across tokens, excluding detached, revoked and foreign shares', async () => {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('G.md', 'G'))
        const h = success(await f.root.create('H.md', 'H'))
        const text = '---\ngroups: ["[[G]]", "[[H]]"]\n---\nshared'
        const note = success(await f.root.create('note.md', text))
        const share = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'group', id: g.file_id },
          label: 'G',
        })
        const other = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'group', id: h.file_id },
          label: 'H',
        })
        const itemId = `primary:${share.info.id}`
        const path = `/tokens/${share.info.id}/items/${itemId}/preview`
        const preview = await f.root.json(path)
        expect(preview).toMatchObject({ file_count: 2, total_bytes: 1 + Buffer.byteLength(text) })
        expect(preview.files.map((file: { path: string }) => file.path)).toEqual([
          'G.md',
          'note.md',
        ])
        const shared = preview.files.find(
          (file: { file_id: string }) => file.file_id === note.file_id
        )
        expect(shared.overlaps).toContainEqual(
          expect.objectContaining({
            token_id: other.info.id,
            item_id: `primary:${other.info.id}`,
            scope: { kind: 'group', id: h.file_id, path: 'H.md' },
          })
        )
        expect(shared.overlaps).not.toContainEqual(
          expect.objectContaining({ token_id: share.info.id, item_id: itemId })
        )
        const overlap = success(
          await f.root.create('Agents/overlap.md', '---\ngroups: ["[[G]]"]\n---\ninside')
        )
        const afterAdd = await f.root.json(path)
        expect(afterAdd.file_count).toBe(3)
        expect(
          afterAdd.files.find((file: { file_id: string }) => file.file_id === overlap.file_id)
            .overlaps
        ).toContainEqual(
          expect.objectContaining({
            token_id: f.share.info.id,
            scope: { kind: 'folder', id: f.share.info.scope.id, path: 'Agents' },
          })
        )
        await f.root.json(`/tokens/${other.info.id}`, 'DELETE')
        expect(
          (await f.root.json(path)).files.find(
            (file: { file_id: string }) => file.file_id === note.file_id
          ).overlaps
        ).not.toContainEqual(expect.objectContaining({ token_id: other.info.id }))
        await f.root.commit([
          {
            op: 'modify',
            file_id: note.file_id,
            base_version_id: note.version_id,
            ...(await f.root.upload(Buffer.from('---\ngroups: ["[[H]]"]\n---\nprivate'))),
            mtime: 2000,
          },
        ])
        expect((await f.root.json(path)).files.map((file: { path: string }) => file.path)).toEqual([
          'Agents/overlap.md',
          'G.md',
        ])
        await f.root.json(`/tokens/${f.share.info.id}/items/primary:${f.share.info.id}`, 'DELETE')
        expect(
          (await f.root.json(path)).files.find(
            (file: { file_id: string }) => file.file_id === overlap.file_id
          ).overlaps
        ).not.toContainEqual(expect.objectContaining({ token_id: f.share.info.id }))
      } finally {
        await f.close()
      }
    })

    it('deduplicates token totals across items, honors file identity, and reports removed items as empty', async () => {
      const f = await tokenFixture(dialect)
      try {
        const file = success(await f.root.create('Agents/a.md', 'abc'))
        const group = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'group', id: file.file_id },
        })
        const selected = await f.root.json(`/tokens/${f.share.info.id}/preview`)
        expect(selected).toMatchObject({ file_count: 1, total_bytes: 3 })
        expect(selected.items.map((item: { file_count: number }) => item.file_count)).toEqual([
          1, 1,
        ])
        const outside = success(await f.root.create('outside.md', 'four'))
        const added = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: outside.file_id },
        })
        await f.root.commit([
          {
            op: 'move',
            file_id: outside.file_id,
            base_version_id: outside.version_id,
            to_path: 'renamed.md',
          },
        ])
        expect(
          await f.root.json(`/tokens/${f.share.info.id}/items/${added.id}/preview`)
        ).toMatchObject({ file_count: 1, total_bytes: 4, files: [{ path: 'renamed.md' }] })
        await f.root.json(`/tokens/${f.share.info.id}/items/${group.id}`, 'DELETE')
        expect(
          await f.root.json(`/tokens/${f.share.info.id}/items/${group.id}/preview`)
        ).toMatchObject({ status: 'removed', file_count: 0, total_bytes: 0, files: [] })
        expect(await f.root.json(`/tokens/${f.share.info.id}/preview`)).toMatchObject({
          file_count: 2,
          total_bytes: 7,
        })
      } finally {
        await f.close()
      }
    })

    it('allows the direct issuer and whole-vault owner, refuses holders, siblings and foreign vaults', async () => {
      const f = await tokenFixture(dialect)
      try {
        const child = await f.guest.share(f.share.info.scope.id)
        const holder = new V2SyncClient(child.token)
        const otherUser = await createUser(
          { db: f.t.db, pepper: f.t.config.tokenPepper },
          'Other',
          f.t.address
        )
        const foreign = new V2SyncClient(otherUser.token)
        for (const suffix of ['/preview', `/items/primary:${child.info.id}/preview`]) {
          const path = `/tokens/${child.info.id}${suffix}`
          expect((await f.guest.request(path)).status).toBe(200)
          expect((await f.root.request(path)).status).toBe(200)
          expect((await holder.request(path)).status).toBe(403)
          const sibling = new V2SyncClient((await f.root.share(f.share.info.scope.id)).token)
          expect((await sibling.request(path)).status).toBe(403)
          expect((await foreign.request(path)).status).toBe(403)
        }
        expect(
          (
            await f.root.request(
              `/tokens/${child.info.id}/items/primary:${f.share.info.id}/preview`
            )
          ).status
        ).toBe(403)
      } finally {
        await f.close()
      }
    })
  })
