import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { previewTokenContent } from '../../src/access/contentPreview.js'
import { readCoverage } from '../../src/access/readCoverage.js'
import { covers } from '../../src/access/visibility.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`item read boundaries (${dialect})`, () => {
    it('omits private child items and filters group files and totals to the scoped issuer', async () => {
      const f = await tokenFixture(dialect)
      try {
        const group = success(await f.root.create('Agents/G.md', 'G'))
        const child = await f.guest.share(f.share.info.scope.id)
        const groupItem = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
          scope: { kind: 'group', id: group.file_id },
        })
        const privateFile = success(
          await f.root.create('Private/secret.md', '---\ngroups: ["[[Agents/G]]"]\n---\nprivate')
        )
        const privateItem = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: privateFile.file_id },
        })
        const holder = new V2SyncClient(child.token)
        expect((await holder.json('/connection/items')).items).toHaveLength(3)
        const scoped = await f.guest.json(`/tokens/${child.info.id}/items`)
        expect(scoped.items.map((item: { id: string }) => item.id)).toEqual([
          `primary:${child.info.id}`,
          groupItem.id,
        ])
        const preview = await f.guest.json(`/tokens/${child.info.id}/preview`)
        expect(preview).toMatchObject({
          file_count: 1,
          total_bytes: 1,
          items: [{ files: [{ path: 'Agents/G.md' }] }, { files: [{ path: 'Agents/G.md' }] }],
        })
        expect(preview.items).toHaveLength(2)
        expect(
          (
            await f.guest.json('/tokens', 'GET', undefined, {
              'abele-client-capabilities': 'token-item-count',
            })
          ).items.find((token: { id: string }) => token.id === child.info.id).item_count
        ).toBe(2)
        expect(
          await f.guest.json(`/tokens/${child.info.id}/items/${groupItem.id}/preview`)
        ).toMatchObject({ file_count: 1, total_bytes: 1 })
        expect(
          (await f.root.json(`/tokens/${child.info.id}/items/${groupItem.id}/preview`)).file_count
        ).toBe(2)
        expect(
          (await f.guest.request(`/tokens/${child.info.id}/items/${privateItem.id}/preview`)).status
        ).toBe(403)
        expect((await f.root.json(`/tokens/${child.info.id}/preview`)).file_count).toBe(2)
        expect((await f.root.json(`/tokens/${child.info.id}/items`)).items).toHaveLength(3)
        const callerItem = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: privateFile.file_id },
        })
        expect((await f.guest.json(`/tokens/${child.info.id}/preview`)).file_count).toBe(2)
        const headers = { 'abele-scope-item': `primary:${f.share.info.id}` }
        expect(
          (await f.guest.json(`/tokens/${child.info.id}/preview`, 'GET', undefined, headers))
            .file_count
        ).toBe(1)
        expect(
          (
            await f.guest.request(
              `/tokens/${child.info.id}/items/${privateItem.id}/preview`,
              'GET',
              undefined,
              headers
            )
          ).status
        ).toBe(403)
        await f.root.json(`/tokens/${f.share.info.id}/items/${callerItem.id}`, 'DELETE')
        expect((await f.guest.json(`/tokens/${child.info.id}/preview`)).file_count).toBe(1)
      } finally {
        await f.close()
      }
    })

    it('counts other shares without leaking unowned grants or private group roots', async () => {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('Agents/G.md', 'G'))
        const h = success(await f.root.create('Private/H.md', 'H'))
        const visible = success(await f.root.create('Agents/also.md', 'also'))
        const note = success(
          await f.root.create(
            'Agents/note.md',
            '---\ngroups: ["[[Agents/G]]", "[[Private/H]]", "[[Agents/also]]"]\n---\nnote'
          )
        )
        const issue = (id: string, issuer = f.root) =>
          issuer.json('/tokens', 'POST', { scope: { kind: 'group', id }, label: 'share' })
        const child = await issue(g.file_id, f.guest)
        const hidden = await issue(h.file_id)
        const sibling = await issue(visible.file_id)
        const path = `/tokens/${child.info.id}/items/primary:${child.info.id}/preview`
        const owner = (await f.root.json(path)).files.find(
          (file: { file_id: string }) => file.file_id === note.file_id
        )
        const issuer = (await f.guest.json(path)).files.find(
          (file: { file_id: string }) => file.file_id === note.file_id
        )
        expect(issuer.overlap_count).toBe(owner.overlap_count)
        const serialized = JSON.stringify(issuer.overlaps)
        for (const value of [hidden.info.id, sibling.info.id, h.file_id, 'Private/H.md'])
          expect(serialized).not.toContain(value)
        expect(owner.overlaps).toContainEqual(expect.objectContaining({ token_id: hidden.info.id }))
        expect(owner.overlaps).toContainEqual(
          expect.objectContaining({ token_id: sibling.info.id })
        )
      } finally {
        await f.close()
      }
    })

    it('matches live coverage for configuration paths, group boundaries, files and published assets', async () => {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('Agents/G.md', 'G'))
        const member = success(
          await f.root.create('Agents/member.md', '---\ngroups: ["[[Agents/G]]"]\n---\nmember')
        )
        await f.root.create('Private/member.md', '---\ngroups: ["[[Agents/G]]"]\n---\nprivate')
        await f.root.create('.obsidian/config.md', '---\ngroups: ["[[Agents/G]]"]\n---\nconfig')
        const grant = (issuer: V2SyncClient, kind: 'group' | 'file', id: string) =>
          issuer.json('/tokens', 'POST', { scope: { kind, id }, label: 'test' })
        const rootGroup = new V2SyncClient((await grant(f.root, 'group', g.file_id)).token)
        const scopedGroup = new V2SyncClient((await grant(f.guest, 'group', g.file_id)).token)
        await grant(scopedGroup, 'file', member.file_id)
        const binary = await rootGroup.upload(Buffer.from([1, 2, 3]))
        await rootGroup.json(
          '/group-assets',
          'POST',
          { path: 'asset.bin', ...binary, mtime: 1000 },
          { 'idempotency-key': 'coverage-asset' }
        )
        const deps = { db: f.t.db, pepper: f.t.config.tokenPepper, dialect }
        const snapshot = await readCoverage(deps, f.space)
        for (const scope of await f.t.db
          .selectFrom('access_scopes')
          .selectAll()
          .where('space_id', '=', f.space)
          .execute())
          for (const file of snapshot.files)
            expect(
              await snapshot.covers(scope.id, file.path, file.file_id),
              `${scope.kind}: ${file.path}`
            ).toBe(await covers(deps, scope, file.path, file.file_id))
      } finally {
        await f.close()
      }
    })

    it('uses bounded queries for group previews even when a small path limit covers many notes', async () => {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('G.md', 'G'))
        for (let i = 0; i < 32; i++)
          await f.root.create(`n-${i}.md`, '---\ngroups: ["[[G]]"]\n---\nnote')
        const child = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'group', id: g.file_id },
          label: 'G',
        })
        let queries = 0
        const db = f.t.db.withPlugin({
          transformQuery({ node }) {
            queries++
            return node
          },
          async transformResult({ result }) {
            return result
          },
        })
        const result = await previewTokenContent(
          { db, pepper: f.t.config.tokenPepper, dialect },
          f.root.key,
          child.info.id,
          1
        )
        expect(result.file_count).toBe(33)
        expect(result.items[0]!.files).toHaveLength(1)
        expect(queries).toBeLessThan(150)
        const firstQueries = queries
        for (let i = 32; i < 96; i++)
          await f.root.create(`n-${i}.md`, '---\ngroups: ["[[G]]"]\n---\nnote')
        queries = 0
        const larger = await previewTokenContent(
          { db, pepper: f.t.config.tokenPepper, dialect },
          f.root.key,
          child.info.id,
          1
        )
        expect(larger.file_count).toBe(97)
        expect(larger.items[0]!.files).toHaveLength(1)
        expect(queries).toBeLessThan(150)
        expect(queries).toBeLessThanOrEqual(firstQueries + 5)
      } finally {
        await f.close()
      }
    })
  })
