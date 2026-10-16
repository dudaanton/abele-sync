import { randomUUID } from 'node:crypto'
import { VaultSettingsSchema } from '@abele/sync-protocol'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { releaseRef, TOMBSTONE } from '../blobs/refs.js'
import { hasWaitingEntitlement } from '../blobs/pending.js'
import type { BlobStore } from '../blobs/store.js'

/** Called after metadata purge commits: rollback must never revive references to removed bytes. */
export async function collectPurgedBlobs(db: Kysely<Database>, store: BlobStore, shas: string[]) {
  let removed = 0
  for (const sha of [...new Set(shas)].sort()) {
    const collected = await db.transaction().execute(async (trx) => {
      const claim = await trx
        .updateTable('blobs')
        .set({ refs: TOMBSTONE })
        .where('sha', '=', sha)
        .where('refs', '=', 0)
        .executeTakeFirst()
      if (Number(claim.numUpdatedRows) === 0) return false
      if (await hasWaitingEntitlement(trx, sha, new Date())) {
        await trx.updateTable('blobs').set({ refs: 0 }).where('sha', '=', sha).execute()
        return false
      }
      await store.delete(sha)
      await trx.deleteFrom('blobs').where('sha', '=', sha).execute()
      return true
    })
    if (collected) removed++
  }
  return removed
}

export async function adminAudit(
  db: Kysely<Database>,
  vault: string,
  action: string,
  details: unknown
) {
  await db
    .insertInto('audit')
    .values({
      id: randomUUID(),
      vault_id: vault,
      actor_kind: 'operator',
      actor_id: 'local',
      action,
      path: null,
      result: 'applied',
      at: new Date().toISOString(),
      details: JSON.stringify(details),
    })
    .execute()
}

/** Keep shared blobs; GC removes their bytes only after the final reference is released. */
export async function purgeVault(db: Transaction<Database>, id: string) {
  // Keep only irreversible refusal proofs; no label, token ID, address or content survives here.
  const deletedTokens = await db
    .selectFrom('access_tokens')
    .select(['secret_hash', 'scope_deleted_at'])
    .where('space_id', '=', id)
    .where('scope_deleted_at', 'is not', null)
    .execute()
  for (const token of deletedTokens)
    await db
      .insertInto('scope_deletions')
      .values({ secret_hash: token.secret_hash, deleted_at: token.scope_deleted_at! })
      .onConflict((oc) => oc.column('secret_hash').doNothing())
      .execute()
  const versions = await db
    .selectFrom('versions')
    .select(['blob_sha'])
    .where('vault_id', '=', id)
    .orderBy('blob_sha')
    .execute()
  for (const v of versions) if (v.blob_sha) await releaseRef(db, v.blob_sha)
  const scopes = db.selectFrom('access_scopes').select('id').where('space_id', '=', id)
  const tokens = db.selectFrom('access_tokens').select('id').where('space_id', '=', id)
  await db.deleteFrom('group_write_bases').where('token_id', 'in', tokens).execute()
  await db.deleteFrom('idempotency').where('actor_id', 'in', tokens).execute()
  for (const table of [
    'group_assets',
    'group_notes',
    'group_names',
    'group_links',
    'group_copies',
  ] as const)
    await db.deleteFrom(table).where('space_id', '=', id).execute()
  for (const table of [
    'scope_members',
    'scope_versions',
    'scope_changes',
    'scope_snapshots',
  ] as const)
    await db.deleteFrom(table).where('scope_id', 'in', scopes).execute()
  await db
    .updateTable('access_tokens')
    .set({ issued_by_token_id: null })
    .where('space_id', '=', id)
    .execute()
  await db.deleteFrom('access_tokens').where('space_id', '=', id).execute()
  await db
    .updateTable('access_scopes')
    .set({ boundary_scope_id: null })
    .where('space_id', '=', id)
    .execute()
  await db.deleteFrom('access_scopes').where('space_id', '=', id).execute()
  await db.updateTable('directories').set({ parent_id: null }).where('space_id', '=', id).execute()
  await db.deleteFrom('directories').where('space_id', '=', id).execute()
  for (const table of [
    'versions',
    'files',
    'vault_seq',
    'blob_uploads',
    'uploads',
    'usage_daily',
    'conflict_divergences',
  ] as const)
    await db.deleteFrom(table).where('vault_id', '=', id).execute()
  await db.deleteFrom('spaces').where('id', '=', id).execute()
  await adminAudit(db, id, 'vault.purge', { versions: versions.length })
  return versions.length
}
export function purgeAfter(settings: string, deletedAt: string): number {
  const retention = VaultSettingsSchema.parse(JSON.parse(settings)).retention
  return Date.parse(deletedAt) + Math.max(...Object.values(retention)) * 86400000
}
