import { sql } from 'kysely'
import { describe, expect, it, vi } from 'vitest'
import { createDb } from '../../src/db/connect.js'
import { uploadScopedBlob, requireScopedUpload } from '../../src/scoped/uploads.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { shaOf } from '../helpers/ops.js'
const gate = () => {
  let resolve!: () => void
  return {
    promise: new Promise<void>((r) => {
      resolve = r
    }),
    release: () => resolve(),
  }
}

describe.skipIf(!hasPgTestDb)(
  'scoped upload publication across independent PostgreSQL pools',
  () => {
    it('serializes revoke behind upload publication and never touches the other principal entitlement', async () => {
      const f = await scopedFixture('pg'),
        other = createDb(f.t.databaseUrl!),
        entered = gate(),
        release = gate()
      let publishing: Promise<unknown> | undefined, revoking: Promise<unknown> | undefined
      try {
        const bytes = Buffer.from('same bytes'),
          sha = shaOf(bytes)
        await uploadScopedBlob(f.deps, f.b.key_token, f.vault, f.grant.id, sha, bytes)
        const put = f.t.store.put.bind(f.t.store)
        vi.spyOn(f.t.store, 'put').mockImplementation(async (...args) => {
          entered.release()
          await release.promise
          return put(...args)
        })
        publishing = uploadScopedBlob(f.deps, f.a.key_token, f.vault, f.grant.id, sha, bytes)
        await entered.promise
        const { updateFolderKey } = await import('../../src/auth/folderManagement.js')
        revoking = updateFolderKey(
          { ...f.deps, db: other.db },
          f.owner.accountToken,
          f.vault,
          f.grant.id,
          f.a.key_id,
          { expected_revision: 0, revoke: true }
        )
        let waiting = false
        for (let i = 0; i < 100; i++) {
          const rows =
            await sql`select 1 from pg_locks where locktype='advisory' and not granted and pid in
          (select pid from pg_stat_activity where datname=current_database())`.execute(f.t.db)
          if (rows.rows.length) {
            waiting = true
            break
          }
          await new Promise((r) => setTimeout(r, 5))
        }
        expect(waiting).toBe(true)
        release.release()
        await publishing
        await revoking
        await expect(
          requireScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, sha)
        ).rejects.toMatchObject({ code: 'unauthorized' })
        expect(
          (await requireScopedUpload(f.deps, f.b.key_token, f.vault, f.grant.id, sha)).sha
        ).toBe(sha)
        expect(await f.t.store.has(sha)).toBe(true)
      } finally {
        release.release()
        await Promise.allSettled([publishing, revoking].filter(Boolean))
        vi.restoreAllMocks()
        await other.close()
        await f.close()
      }
    })
  }
)
