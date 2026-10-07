import { AbeleError } from '@abele/sync-protocol'
import { PostgresAdapter, sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import type { AuthDeps } from './accounts.js'

/** Adapted parked account fences: sorted accounts before vault, rows, upload/blob locks.
 * SQLite is the supported single-server model; PG exclusion is database-backed.
 */
export async function lockAccounts(
  tx: Transaction<Database>,
  ids: readonly string[],
  exclusive = false
): Promise<void> {
  if (!(tx.getExecutor().adapter instanceof PostgresAdapter)) return
  for (const id of [...new Set(ids)].sort()) {
    if (exclusive) await sql`select pg_advisory_xact_lock(41,hashtext(${id}))`.execute(tx)
    else await sql`select pg_advisory_xact_lock_shared(41,hashtext(${id}))`.execute(tx)
  }
}
export async function disableAccountWithFence(
  deps: AuthDeps,
  accountId: string,
  at: string
): Promise<void> {
  await deps.db.transaction().execute(async (tx) => {
    await lockAccounts(tx, [accountId], true)
    const changed = await tx
      .updateTable('account_authority')
      .set({ revision: sql<number>`revision + 1` })
      .where('account_id', '=', accountId)
      .executeTakeFirst()
    if (Number(changed.numUpdatedRows) !== 1)
      throw new AbeleError('unauthorized', 'account authority is unavailable')
    await tx.updateTable('accounts').set({ disabled_at: at }).where('id', '=', accountId).execute()
  })
}
