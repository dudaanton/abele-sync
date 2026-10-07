import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'

/** Called under the same vault lock as retention and future snapshot/worker publication.
 * Compact admissions/origins never pin bytes. Only bounded live leases do.
 */
export async function activeScopedPins(
  tx: Transaction<Database>,
  vaultId: string,
  now: Date
): Promise<Set<string>> {
  const at = now.toISOString()
  await tx
    .deleteFrom('scope_snapshots')
    .where('vault_id', '=', vaultId)
    .where((eb) => eb.or([eb('expires_at', '<=', at), eb('state', '=', 'invalidated')]))
    .execute()
  await tx
    .deleteFrom('scope_group_leases')
    .where('vault_id', '=', vaultId)
    .where('expires_at', '<=', at)
    .execute()
  const snapshots = await tx
    .selectFrom('scope_snapshot_pins as pins')
    .innerJoin('scope_snapshots as snapshot', 'snapshot.id', 'pins.snapshot_id')
    .select('pins.version_id')
    .where('pins.vault_id', '=', vaultId)
    .where('snapshot.expires_at', '>', at)
    .where('snapshot.state', 'in', ['paging', 'complete'])
    .execute()
  const preparation = await tx
    .selectFrom('scope_group_pins as pins')
    .innerJoin('scope_group_leases as lease', 'lease.id', 'pins.lease_id')
    .select('pins.version_id')
    .where('pins.vault_id', '=', vaultId)
    .where('lease.expires_at', '>', at)
    .execute()
  return new Set([...snapshots, ...preparation].map((row) => row.version_id))
}
