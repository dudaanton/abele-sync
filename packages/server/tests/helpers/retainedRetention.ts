import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/schema.js'
import { runRetention, type RetentionDeps } from '../../src/history/retention.js'
import { sweepIdempotency } from '../legacy/src/api/idempotency.js'
import { getVaultSettings } from '../legacy/src/vault/vaults.js'

/** Only an engine regression fixture catalog, never a public runtime compatibility path. */
export async function runRetainedEngineRetention(deps: RetentionDeps) {
  const actors = await deps.db
    .selectFrom('devices')
    .select('id')
    .where('revoked_at', 'is', null)
    .execute()
  return runRetention({
    ...deps,
    liveReceiptActors: actors.map((actor) => actor.id),
    catalog: {
      list: (db) => db.selectFrom('vaults').select('id').orderBy('created_at').execute(),
      settings: (db, id) => getVaultSettings({ db }, id),
    },
  })
}
export async function sweepRetainedEngineReceipts(db: Kysely<Database>, olderThan: Date) {
  const actors = await db
    .selectFrom('devices')
    .select('id')
    .where('revoked_at', 'is', null)
    .execute()
  return sweepIdempotency(
    db,
    olderThan,
    actors.map((actor) => actor.id)
  )
}
