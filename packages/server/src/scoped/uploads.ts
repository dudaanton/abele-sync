import { createHash } from 'node:crypto'
import { AbeleError, ShaSchema } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import { authNow } from '../auth/accounts.js'
import { hasRoom } from '../blobs/pending.js'
import type { BlobStore } from '../blobs/store.js'
import type { Database } from '../db/schema.js'
import { withScopedAuthority, type ScopedAuthority, type ScopedDeps } from './authority.js'

export const SCOPED_UPLOAD_LIMITS = Object.freeze({
  maxBlobBytes: 8 * 1024 * 1024,
  maxPendingBytes: 64 * 1024 * 1024,
  maxEntries: 64,
  lifetimeMs: 24 * 60 * 60 * 1000,
})
export const SCOPED_PENDING_LIMITS = Object.freeze({ maxEntries: 64, maxBytes: 256 * 1024 * 1024 })
/** One budget across live completed entitlements and multipart reservations.
 * Caller holds principal/authority/vault fences. Completion replaces its own
 * reservation; re-proving the same SHA replaces, rather than double-counts, it.
 */
export async function requireScopedPendingRoom(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  sha: string,
  size: number,
  at: Date,
  excludeUploadId?: string,
  reserve = false
) {
  const completed = await tx
    .selectFrom('scope_blob_uploads')
    .select(['sha', 'size'])
    .where('principal_kind', '=', a.principal.kind)
    .where('principal_id', '=', a.principal.principal_id)
    .where('expires_at', '>', at.toISOString())
    .limit(SCOPED_PENDING_LIMITS.maxEntries + 1)
    .execute()
  let query = tx
    .selectFrom('scope_uploads')
    .select(['id', 'sha', 'size'])
    .where('principal_kind', '=', a.principal.kind)
    .where('principal_id', '=', a.principal.principal_id)
    .where('expires_at', '>', at.toISOString())
  if (excludeUploadId) query = query.where('id', '!=', excludeUploadId)
  const reserved = await query.limit(SCOPED_PENDING_LIMITS.maxEntries + 1).execute()
  const old = reserve ? undefined : completed.find((row) => row.sha === sha)
  if (
    completed.length + reserved.length + (old ? 0 : 1) > SCOPED_PENDING_LIMITS.maxEntries ||
    completed.reduce((sum, row) => sum + row.size, 0) +
      reserved.reduce((sum, row) => sum + row.size, 0) -
      (old?.size ?? 0) +
      size >
      SCOPED_PENDING_LIMITS.maxBytes
  )
    throw new AbeleError('quota_waiting', 'scoped pending-upload budget reached')
}

export interface ScopedUploadDeps extends ScopedDeps {
  store: BlobStore
  maxScopedUploadBytes?: number
}
const miss = () => new AbeleError('not_found', 'no authorized upload')
const owned = (a: ScopedAuthority) => ({
  vault_id: a.principal.vault_id,
  grant_id: a.principal.grant_id,
  principal_kind: a.principal.kind,
  principal_id: a.principal.principal_id,
  key_id: a.principal.kind === 'key' ? a.principal.principal_id : null,
  installation_id: a.principal.kind === 'installation' ? a.principal.principal_id : null,
})
/** This proves ownership only, not destination/publication authority. Knowing a private SHA,
 * a personal upload or an unrelated admitted version never substitutes for own uploaded bytes.
 */
export async function scopedUploadInTransaction(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  sha: string,
  at: Date
) {
  const row = await tx
    .selectFrom('scope_blob_uploads')
    .select(['sha', 'size'])
    .where('vault_id', '=', a.principal.vault_id)
    .where('grant_id', '=', a.principal.grant_id)
    .where('principal_kind', '=', a.principal.kind)
    .where('principal_id', '=', a.principal.principal_id)
    .where('sha', '=', sha)
    .where('expires_at', '>', at.toISOString())
    .executeTakeFirst()
  if (!row) throw miss()
  return row
}
export async function consumeScopedUploadInTransaction(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  sha: string,
  at: Date
): Promise<void> {
  await scopedUploadInTransaction(tx, a, sha, at)
  await tx
    .deleteFrom('scope_blob_uploads')
    .where('vault_id', '=', a.principal.vault_id)
    .where('grant_id', '=', a.principal.grant_id)
    .where('principal_kind', '=', a.principal.kind)
    .where('principal_id', '=', a.principal.principal_id)
    .where('sha', '=', sha)
    .execute()
}
export async function requireScopedUpload(
  deps: ScopedDeps,
  token: string,
  vaultId: string,
  grantId: string,
  sha: string
) {
  return withScopedAuthority(deps, token, vaultId, grantId, 'stage', (tx, a) =>
    scopedUploadInTransaction(tx, a, sha, authNow(deps))
  )
}
export async function consumeScopedUpload(
  deps: ScopedDeps,
  token: string,
  vaultId: string,
  grantId: string,
  sha: string
): Promise<void> {
  await withScopedAuthority(deps, token, vaultId, grantId, 'stage', (tx, a) =>
    consumeScopedUploadInTransaction(tx, a, sha, authNow(deps))
  )
}
/** Bounded one-shot PUT. Full bytes must hash correctly even when the store has that SHA.
 * The global blob-row lock excludes physical collectors while entitlement/store publication
 * is pending; the final authority check rolls the row back on expiry/revocation.
 */
export async function uploadScopedBlob(
  deps: ScopedUploadDeps,
  token: string,
  vaultId: string,
  grantId: string,
  sha: string,
  bytes: Uint8Array
) {
  return withScopedAuthority(deps, token, vaultId, grantId, 'stage', async (tx, a) => {
    const at = authNow(deps),
      size = bytes.byteLength,
      limit = Math.min(
        deps.maxScopedUploadBytes ?? SCOPED_UPLOAD_LIMITS.maxBlobBytes,
        SCOPED_UPLOAD_LIMITS.maxBlobBytes
      )
    if (size > limit) throw new AbeleError('too_large', 'scoped upload limit exceeded')
    if (
      !ShaSchema.safeParse(sha).success ||
      createHash('sha256').update(bytes).digest('hex') !== sha
    )
      throw new AbeleError('hash_mismatch', 'uploaded bytes do not match the requested hash')
    await tx
      .deleteFrom('scope_blob_uploads')
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where('expires_at', '<=', at.toISOString())
      .execute()
    const pending = await tx
      .selectFrom('scope_blob_uploads')
      .select(['sha', 'size'])
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .limit(SCOPED_UPLOAD_LIMITS.maxEntries + 1)
      .execute()
    const old = pending.find((row) => row.sha === sha)
    if (
      (!old && pending.length >= SCOPED_UPLOAD_LIMITS.maxEntries) ||
      pending.reduce((total, row) => total + row.size, 0) - (old?.size ?? 0) + size >
        SCOPED_UPLOAD_LIMITS.maxPendingBytes
    ) {
      throw new AbeleError('quota_waiting', 'scoped pending-upload budget reached')
    }
    await requireScopedPendingRoom(tx, a, sha, size, at)
    try {
      await hasRoom(tx, vaultId, sha, size, at)
    } catch (error) {
      if (error instanceof AbeleError) throw new AbeleError(error.code, 'upload budget unavailable')
      throw error
    }
    const blob = await tx
      .insertInto('blobs')
      .values({
        sha,
        size,
        storage_ref: deps.store.pathFor(sha),
        refs: 0,
        created_at: at.toISOString(),
        last_referenced_at: at.toISOString(),
      })
      .onConflict((oc) =>
        oc
          .column('sha')
          .doUpdateSet({ last_referenced_at: at.toISOString() })
          .where('blobs.refs', '>=', 0)
      )
      .returning('sha')
      .executeTakeFirst()
    if (!blob) throw miss()
    await tx
      .insertInto('scope_blob_uploads')
      .values({
        ...owned(a),
        sha,
        size,
        created_at: at.toISOString(),
        expires_at: new Date(at.getTime() + SCOPED_UPLOAD_LIMITS.lifetimeMs).toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(['vault_id', 'sha', 'principal_kind', 'principal_id']).doUpdateSet({
          expires_at: new Date(at.getTime() + SCOPED_UPLOAD_LIMITS.lifetimeMs).toISOString(),
        })
      )
      .execute()
    await deps.store.put(bytes, sha)
    return { sha, size }
  })
}
