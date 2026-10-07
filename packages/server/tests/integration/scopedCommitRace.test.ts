import { sql } from 'kysely'
import { describe, expect, it, vi } from 'vitest'
import { createDb } from '../../src/db/connect.js'
import { commitScoped } from '../../src/scoped/commits.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { updateFolderKey } from '../../src/auth/folderManagement.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { create, shaOf } from '../helpers/ops.js'
const gate = () => {
  let resolve!: () => void
  return {
    promise: new Promise<void>((r) => {
      resolve = r
    }),
    release: () => resolve(),
  }
}
async function waiter(db: ReturnType<typeof createDb>['db']) {
  for (let i = 0; i < 100; i++) {
    if (
      (
        await sql`select 1 from pg_locks where locktype='advisory' and not granted and pid in(select pid from pg_stat_activity where datname=current_database())`.execute(
          db
        )
      ).rows.length
    )
      return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return false
}
describe.skipIf(!hasPgTestDb)('scoped commit receipts across independent PostgreSQL pools', () => {
  for (const second of ['retry', 'revoke'] as const)
    it(`serializes ${second} after the inner publication check without duplicate outputs or later forbidden replay`, async () => {
      const f = await scopedFixture('pg'),
        other = createDb(f.t.databaseUrl!),
        entered = gate(),
        release = gate()
      let publishing: Promise<unknown> | undefined, competing: Promise<unknown> | undefined
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('new'),
          Buffer.from('new')
        )
        const size = f.t.store.size.bind(f.t.store)
        vi.spyOn(f.t.store, 'size').mockImplementation(async (sha) => {
          entered.release()
          await release.promise
          return size(sha)
        })
        const ops = [create('Agents/race.md', 'new')]
        publishing = commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'race', ops)
        await entered.promise
        competing =
          second === 'retry'
            ? commitScoped(
                { ...f.deps, db: other.db },
                f.a.key_token,
                f.vault,
                f.grant.id,
                'race',
                ops
              )
            : updateFolderKey(
                { ...f.deps, db: other.db },
                f.owner.accountToken,
                f.vault,
                f.grant.id,
                f.a.key_id,
                { expected_revision: 0, revoke: true }
              )
        expect(await waiter(f.t.db)).toBe(true)
        release.release()
        const first = await publishing,
          next = await competing
        if (second === 'retry') expect(next).toEqual(first)
        else
          await expect(
            commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'race', ops)
          ).rejects.toMatchObject({ code: 'unauthorized' })
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(1)
        expect(
          await f.t.db.selectFrom('scope_receipts').select('outcome_id').execute()
        ).toHaveLength(1)
      } finally {
        release.release()
        await Promise.allSettled([publishing, competing].filter(Boolean))
        vi.restoreAllMocks()
        await other.close()
        await f.close()
      }
    })
})
