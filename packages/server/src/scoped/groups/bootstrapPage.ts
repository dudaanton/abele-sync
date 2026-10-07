import { AbeleError } from '@abele/sync-protocol'
import { sql, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'

/** The caller holds the owner/vault lock. Roll back partial capture, but commit
 * a proven terminal failure before returning it to the caller to throw. Keeping
 * the lock through both operations also prevents poisoning a concurrent rebuild.
 */
export async function withGroupBootstrapPage<T>(
  tx: Transaction<Database>,
  vaultId: string,
  at: Date,
  capture: () => Promise<T>
): Promise<{ result: T } | { error: AbeleError }> {
  const head = await tx
    .selectFrom('vault_seq')
    .select('head_seq')
    .where('vault_id', '=', vaultId)
    .executeTakeFirstOrThrow()
  // The first page may be the first group work ever. Its failure marker must
  // survive even though the lease, pins and parse facts all roll back.
  await tx
    .insertInto('scope_group_progress')
    .values({
      vault_id: vaultId,
      generation: 0,
      processed_seq: head.head_seq,
      bootstrap_start_seq: head.head_seq,
      bootstrap_cursor: null,
      status: 'preparing',
      updated_at: at.toISOString(),
    })
    .onConflict((oc) => oc.column('vault_id').doNothing())
    .execute()
  await sql`savepoint group_bootstrap_page`.execute(tx)
  try {
    const result = await capture()
    await sql`release savepoint group_bootstrap_page`.execute(tx)
    return { result }
  } catch (error) {
    if (
      !(error instanceof AbeleError) ||
      error.code !== 'scope_unavailable' ||
      error.details.retryable === true
    )
      throw error // Operational failures roll back the entire owner transaction.
    await sql`rollback to savepoint group_bootstrap_page`.execute(tx)
    await tx
      .updateTable('scope_group_progress')
      .set({ status: 'unavailable', updated_at: at.toISOString() })
      .where('vault_id', '=', vaultId)
      .execute()
    await sql`release savepoint group_bootstrap_page`.execute(tx)
    return { error }
  }
}
