import type { Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
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
