import { describe, expect, it } from 'vitest'
import type { KyselyPlugin } from 'kysely'
import { withScopedAuthority } from '../../src/scoped/authority.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { scopedFixture } from '../helpers/scopedFixture.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped expiry boundary (${dialect})`, () => {
    it('rolls back publication when credential expires after final select began but before completion', async () => {
      const f = await scopedFixture(dialect)
      try {
        let seen = 0,
          selected = false
        const plugin: KyselyPlugin = {
          transformQuery({ node }) {
            selected =
              node.kind === 'SelectQueryNode' && JSON.stringify(node).includes('scope_keys')
            return node
          },
          async transformResult({ result }) {
            if (selected && ++seen === 4) f.setClock('2030-01-02T00:00:00.000Z')
            return result
          },
        }
        const deps = { ...f.deps, db: f.t.db.withPlugin(plugin) }
        await expect(
          withScopedAuthority(deps, f.a.key_token, f.vault, f.grant.id, 'stage', async (tx) => {
            await tx
              .insertInto('scope_blob_uploads')
              .values({
                vault_id: f.vault,
                grant_id: f.grant.id,
                principal_kind: 'key',
                principal_id: f.a.key_id,
                key_id: f.a.key_id,
                installation_id: null,
                sha: 'a'.repeat(64),
                size: 1,
                created_at: f.deps.now().toISOString(),
                expires_at: '2030-01-03T00:00:00.000Z',
              })
              .execute()
          })
        ).rejects.toMatchObject({ code: 'unauthorized' })
        expect(seen).toBeGreaterThanOrEqual(4)
        expect(await f.t.db.selectFrom('scope_blob_uploads').selectAll().execute()).toEqual([])
      } finally {
        await f.close()
      }
    })
  })
}
