import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { reduceGroupOrigins } from '../../src/scoped/groups/origins.js'
import { storeGroupOrigins } from '../../src/scoped/groups/originStore.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `immutable group origin persistence (${dialect})`,
    () => {
      it('retains recipient source attribution in a copied identity without upgrading it to the copying owner', async () => {
        const f = await scopedFixture(dialect)
        try {
          const first = reduceGroupOrigins({
            versionId: 'recipient-version',
            ownerAccountId: f.owner.accountId,
            writer: {
              facet: 'scoped',
              principalId: f.a.key_id,
              accountId: f.owner.accountId,
              grantId: f.grant.id,
            },
            operation: 'modify',
            status: 'valid',
            tokens: [{ key: 'projects/root', targetId: 'root' }],
          })
          const saved = await f.t.db
            .transaction()
            .execute((tx) =>
              storeGroupOrigins(tx, f.vault, 'source', first, f.deps.now().toISOString())
            )
          const copy = await f.t.db
            .transaction()
            .execute((tx) =>
              storeGroupOrigins(tx, f.vault, 'copy', saved, f.deps.now().toISOString())
            )
          expect(copy.memory['projects/root']!.origin.id).not.toBe(
            saved.memory['projects/root']!.origin.id
          )
          const rows = await f.t.db.selectFrom('scope_group_origins').selectAll().execute()
          expect(rows).toHaveLength(2)
          expect(
            rows.every(
              (row) =>
                row.origin_kind === 'recipient' &&
                row.introduced_version_id === 'recipient-version' &&
                row.writer_principal_id === f.a.key_id
            )
          ).toBe(true)
        } finally {
          await f.close()
        }
      })
    }
  )
