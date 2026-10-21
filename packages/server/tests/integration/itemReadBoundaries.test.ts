import { describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { previewTokenContent } from '../../src/access/contentPreview.js'
import { readCoverage } from '../../src/access/readCoverage.js'
import { covers } from '../../src/access/visibility.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`item read boundaries (${dialect})`, () => {
    it('redacts file and folder token paths after their issuer moves into configuration content', async () => {
      const f = await tokenFixture(dialect)
      try {
        const nested = success(
          (await f.root.commit([{ op: 'mkdir', path: 'Agents/Sub' }])).results[0]!
        )
        const note = success(await f.root.create('Agents/secret.md', 'secret'))
        const file = await f.guest.json('/tokens', 'POST', {
          scope: { kind: 'file', id: note.file_id },
          label: 'file',
        })
        const folder = await f.guest.share(nested.file_id)
        const head = (await f.root.manifest()).items.find(
          (item) => item.file_id === f.share.info.scope.id
        )!
        success(
          (
            await f.root.commit([
              {
                op: 'move_directory',
                file_id: head.file_id,
                base_version_id: head.version_id,
                to_path: '.obsidian/Agents',
              },
            ])
          ).results[0]!
        )
        expect((await f.guest.request(`/files/${note.file_id}/content`)).status).toBe(404)
        const listing = await f.guest.json('/tokens')
        for (const child of [file, folder])
          expect(
            listing.items.find((item: { id: string }) => item.id === child.info.id).scope.path
          ).toBe('(unavailable)')
      } finally {
        await f.close()
      }
    })

    it('rejects unknown and hidden item previews before any bulk snapshot or grant enumeration', async () => {
      const f = await tokenFixture(dialect)
      try {
        const child = await f.guest.share(f.share.info.scope.id)
        const note = success(await f.root.create('Private/secret.md', 'secret'))
        const hidden = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: note.file_id },
        })
        const sql: string[] = []
        // Capture query trees through transactions; compare work, not wall time.
        for (const id of ['unknown', hidden.id]) {
          sql.length = 0
          let queries = 0
          const counted = f.t.db.withPlugin({
            transformQuery({ node }) {
              queries++
              sql.push(JSON.stringify(node))
              return node
            },
            async transformResult({ result }) {
              return result
            },
          })
          await expect(
            previewTokenContent(
              { db: counted, pepper: f.t.config.tokenPepper, dialect },
              f.guest.key,
              child.info.id,
              1,
              id
            )
          ).rejects.toMatchObject({ code: 'forbidden', message: 'scope_removed' })
          expect(
            sql.some(
              (query) =>
                query.includes('group_links') ||
                query.includes('scope_members') ||
                query.includes('versions')
            )
          ).toBe(false)
          expect(queries).toBeLessThan(40)
        }
      } finally {
        await f.close()
      }
    })

    it('bounds hidden-item denial queries for group issuers independently of group size', async () => {
      let first = 0
      for (const size of [16, 48]) {
        const f = await tokenFixture(dialect)
        try {
          const g = success(await f.root.create('G.md', 'G'))
          for (let i = 0; i < size; i++)
            success(await f.root.create(`member-${i}.md`, '---\ngroups: ["[[G]]"]\n---\nnote'))
          const privateFile = success(await f.root.create('Private/secret.md', 'secret'))
          const issued = await f.root.json('/tokens', 'POST', {
            scope: { kind: 'group', id: g.file_id },
            label: 'G',
          })
          const group = new V2SyncClient(issued.token)
          const child = await group.json('/tokens', 'POST', {
            scope: { kind: 'group', id: g.file_id },
            label: 'child',
          })
          const hidden = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
            scope: { kind: 'file', id: privateFile.file_id },
          })
          let queries = 0
          const sql: string[] = []
          const db = f.t.db.withPlugin({
            transformQuery({ node }) {
              queries++
              sql.push(JSON.stringify(node))
              return node
            },
            async transformResult({ result }) {
              return result
            },
          })
          for (const id of ['unknown', hidden.id]) {
            queries = 0
            sql.length = 0
            await expect(
              previewTokenContent(
                { db, pepper: f.t.config.tokenPepper, dialect },
                group.key,
                child.info.id,
                1,
                id
              )
            ).rejects.toMatchObject({ code: 'forbidden', message: 'scope_removed' })
            expect(sql.some((q) => q.includes('versions') || q.includes('scope_members'))).toBe(
              false
            )
            expect(queries).toBeLessThan(40)
            if (id === hidden.id) {
              if (size === 16) first = queries
              else expect(queries).toBeLessThanOrEqual(first)
            }
          }
          // The early check must still admit a selector in the caller's group.
          expect(
            (await group.json(`/tokens/${child.info.id}/items/primary:${child.info.id}/preview`))
              .file_count
          ).toBe(size + 1)
        } finally {
          await f.close()
        }
      }
    })

    it('keeps query growth linear when each group note has its own inherited file grant', async () => {
      let first = 0
      for (const size of [16, 48]) {
        const f = await tokenFixture(dialect)
        try {
          const g = success(await f.root.create('G.md', 'G'))
          const files = []
          for (let i = 0; i < size; i++)
            files.push(
              success(await f.root.create(`member-${i}.md`, '---\ngroups: ["[[G]]"]\n---\nnote'))
            )
          const issued = await f.root.json('/tokens', 'POST', {
            scope: { kind: 'group', id: g.file_id },
            label: 'G',
          })
          const group = new V2SyncClient(issued.token)
          const grant = await group.json('/tokens', 'POST', {
            scope: { kind: 'file', id: files[0]!.file_id },
            label: 'file',
          })
          // Clone one real grant and its projection to isolate preview cost from
          // the unrelated issuance/refresh work of building a large fixture.
          const template = await f.t.db
            .selectFrom('access_tokens')
            .selectAll()
            .where('id', '=', grant.info.id)
            .executeTakeFirstOrThrow()
          const scope = await f.t.db
            .selectFrom('access_scopes')
            .selectAll()
            .where('id', '=', template.scope_id)
            .executeTakeFirstOrThrow()
          const members = await f.t.db
            .selectFrom('scope_members')
            .selectAll()
            .where('scope_id', '=', scope.boundary_scope_id!)
            .execute()
          for (const file of files.slice(1)) {
            const id = randomUUID(),
              scopeId = randomUUID()
            await f.t.db
              .insertInto('access_scopes')
              .values({
                ...scope,
                id: scopeId,
                target_id: file.file_id,
                effective_key: `file:${file.file_id}:${scope.boundary_scope_id}`,
              })
              .execute()
            await f.t.db
              .insertInto('access_tokens')
              .values({
                ...template,
                id,
                scope_id: scopeId,
                secret_hash: createHash('sha256').update(id).digest('hex'),
              })
              .execute()
            const member = members.find((row) => row.file_id === file.file_id)!
            await f.t.db
              .insertInto('scope_members')
              .values({ ...member, scope_id: scopeId })
              .execute()
            await f.t.db
              .insertInto('scope_versions')
              .values({
                scope_id: scopeId,
                file_id: file.file_id,
                version_id: JSON.parse(member.item).version_id,
              })
              .execute()
          }
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
          const preview = await previewTokenContent(
            { db, pepper: f.t.config.tokenPepper, dialect },
            f.root.key,
            issued.info.id,
            1
          )
          expect(preview.file_count).toBe(size + 1)
          expect(queries).toBeLessThan(3 * size + 150)
          if (size === 16) first = queries
          else expect(queries).toBeLessThanOrEqual(first + 3 * 32 + 10)
        } finally {
          await f.close()
        }
      }
    })
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
        const selectors = await readCoverage(deps, f.space, 'selectors')
        for (const scope of await f.t.db
          .selectFrom('access_scopes')
          .selectAll()
          .where('space_id', '=', f.space)
          .execute())
          for (const file of snapshot.files) {
            expect(
              await snapshot.covers(scope.id, file.path, file.file_id),
              `${scope.kind}: ${file.path}`
            ).toBe(await covers(deps, scope, file.path, file.file_id))
            expect(await selectors.covers(scope.id, file.path, file.file_id)).toBe(
              await snapshot.covers(scope.id, file.path, file.file_id)
            )
          }
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
