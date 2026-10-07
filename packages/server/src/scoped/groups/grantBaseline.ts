import { sql, type Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
/** Called under the owner mutation's vault lock, before creating/renewing the
 * first live group audience. No evidence is collected while all groups are
 * retired, so the old replay watermark is not a baseline for this audience.
 * Preserve immutable provenance/bindings; only retire abandoned capture work.
 * An existing unexpired authority (even unavailable) must never be skipped.
 */
export async function restartRetiredGroupBaseline(
  tx: Transaction<Database>,
  vault: string,
  seq: number,
  at: Date
) {
  const live = await tx
    .selectFrom('scope_grants')
    .select('id')
    .where('vault_id', '=', vault)
    .where('selector_kind', '=', 'group')
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())]))
    .limit(1)
    .executeTakeFirst()
  if (live) return
  await tx
    .updateTable('scope_group_progress')
    .set({
      generation: sql<number>`generation + 1`,
      processed_seq: seq,
      bootstrap_start_seq: seq,
      bootstrap_cursor: null,
      status: 'preparing',
      updated_at: at.toISOString(),
    })
    .where('vault_id', '=', vault)
    .execute()
  await tx.deleteFrom('scope_group_dirty').where('vault_id', '=', vault).execute()
  // Pins belong only to group preparation; the lease FK cascades their removal.
  await tx.deleteFrom('scope_group_leases').where('vault_id', '=', vault).execute()
}

/** 009's grant-local preparation row retains a complete group's admission lower
 * bound too. Complete rows are durable metadata, not renewable capture leases.
 */
export async function setGroupAdmissionStart(
  tx: Transaction<Database>,
  vault: string,
  grant: string,
  seq: number,
  at: Date,
  replace = false
) {
  const values = {
    grant_id: grant,
    vault_id: vault,
    phase: 'complete' as const,
    start_seq: seq,
    replay_seq: seq,
    inventory_cursor: null,
    created_at: at.toISOString(),
    updated_at: at.toISOString(),
    expires_at: new Date(at.getTime() + 300000).toISOString(),
  }
  await tx
    .insertInto('scope_folder_preparations')
    .values(values)
    .onConflict((oc) =>
      replace ? oc.column('grant_id').doUpdateSet(values) : oc.column('grant_id').doNothing()
    )
    .execute()
}
