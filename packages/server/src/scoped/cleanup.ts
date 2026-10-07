import { AbeleError } from '@abele/sync-protocol'
import { lstat, opendir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withVaultLock } from '../oplog/lock.js'
import { lockAccounts } from '../auth/accountFence.js'
import type { ScopedUploadDeps } from './uploads.js'
export type ScopedCleanupDeps = Pick<ScopedUploadDeps, 'db' | 'dialect' | 'store' | 'now'>
const cleanupNow = (deps: ScopedCleanupDeps) => deps.now?.() ?? new Date()
import { SCOPED_RESOURCE_LIMITS } from './resourceLimits.js'
export { SCOPED_RESOURCE_LIMITS } from './resourceLimits.js'
const valid = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new AbeleError('invalid_request', 'cleanup page bound exceeded')
}
async function partRootInfo(root: string) {
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new AbeleError('scope_unavailable', 'unsafe multipart storage root')
  return info
}
async function removeParts(deps: ScopedCleanupDeps, id: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return false
  const root = join(deps.store.dir, 'scoped-upload-parts'),
    info = await partRootInfo(root)
  if (!info) return false
  await rm(join(root, id), { recursive: true, force: true })
  return true
}
/** Internal maintenance, one bounded page under the same vault fence as writers.
 * Durable authority/admission/origin/outcome identity is never expired as payload.
 */
export async function cleanupScopedVault(
  deps: ScopedCleanupDeps,
  vault: string,
  options: { limit?: number; feedKeep?: number; afterGrant?: string } = {}
) {
  const limit = options.limit ?? 1000,
    feedKeep = options.feedKeep ?? SCOPED_RESOURCE_LIMITS.feedEvents
  valid(limit)
  if (
    !Number.isSafeInteger(feedKeep) ||
    feedKeep < 1 ||
    feedKeep > SCOPED_RESOURCE_LIMITS.feedEvents
  )
    throw new AbeleError('invalid_request', 'invalid feed retention bound')
  const owner = await deps.db
    .selectFrom('vaults')
    .select('owner_account_id')
    .where('id', '=', vault)
    .executeTakeFirst()
  if (!owner) return { removed: 0, payloads: 0, nextGrant: null, more: false }
  return withVaultLock(
    deps.db,
    deps.dialect,
    vault,
    async (tx) => {
      const at = cleanupNow(deps).toISOString()
      let removed = 0,
        payloads = 0
      const snapshots = await tx
        .selectFrom('scope_snapshots')
        .select('id')
        .where('vault_id', '=', vault)
        .where((eb) => eb.or([eb('expires_at', '<=', at), eb('state', '=', 'invalidated')]))
        .limit(limit)
        .execute()
      for (const row of snapshots) {
        await tx.deleteFrom('scope_snapshots').where('id', '=', row.id).execute()
        removed++
      }
      const leases = await tx
        .selectFrom('scope_group_leases')
        .select('id')
        .where('vault_id', '=', vault)
        .where('expires_at', '<=', at)
        .limit(limit)
        .execute()
      for (const row of leases) {
        await tx.deleteFrom('scope_group_leases').where('id', '=', row.id).execute()
        removed++
      }
      const uploads = await tx
        .selectFrom('scope_uploads')
        .select('id')
        .where('vault_id', '=', vault)
        .where('expires_at', '<=', at)
        .limit(limit)
        .execute()
      for (const row of uploads) {
        await removeParts(deps, row.id)
        await tx
          .deleteFrom('scope_uploads')
          .where('id', '=', row.id)
          .where('expires_at', '<=', at)
          .execute()
        removed++
      }
      const entitlements = await tx
        .selectFrom('scope_blob_uploads')
        .select(['sha', 'principal_kind', 'principal_id'])
        .where('vault_id', '=', vault)
        .where('expires_at', '<=', at)
        .limit(limit)
        .execute()
      for (const row of entitlements) {
        await tx
          .deleteFrom('scope_blob_uploads')
          .where('vault_id', '=', vault)
          .where('principal_kind', '=', row.principal_kind)
          .where('principal_id', '=', row.principal_id)
          .where('sha', '=', row.sha)
          .where('expires_at', '<=', at)
          .execute()
        removed++
      }
      const receipts = await tx
        .selectFrom('scope_receipts')
        .select(['principal_kind', 'principal_id', 'endpoint_identity', 'request_id'])
        .where('vault_id', '=', vault)
        .where('payload_expires_at', '<=', at)
        .where('response', 'is not', null)
        .limit(limit)
        .execute()
      for (const row of receipts) {
        await tx
          .updateTable('scope_receipts')
          .set({ response: null })
          .where('principal_kind', '=', row.principal_kind)
          .where('principal_id', '=', row.principal_id)
          .where('endpoint_identity', '=', row.endpoint_identity)
          .where('request_id', '=', row.request_id)
          .execute()
        payloads++
      }
      const grants = tx.selectFrom('scope_grants').select('id').where('vault_id', '=', vault)
      const publications = await tx
        .selectFrom('scope_publication_outcomes')
        .select(['grant_id', 'owner_device_id', 'intent_id'])
        .where('grant_id', 'in', grants)
        .where('payload_expires_at', '<=', at)
        .where('outcome', 'is not', null)
        .limit(limit)
        .execute()
      for (const row of publications) {
        await tx
          .updateTable('scope_publication_outcomes')
          .set({ outcome: null })
          .where('grant_id', '=', row.grant_id)
          .where('owner_device_id', '=', row.owner_device_id)
          .where('intent_id', '=', row.intent_id)
          .execute()
        payloads++
      }
      const keys = await tx
        .selectFrom('scope_key_issuances')
        .select(['account_id', 'grant_id', 'attempt_id'])
        .where('grant_id', 'in', grants)
        .where('expires_at', '<=', at)
        .where('protected_token', 'is not', null)
        .limit(limit)
        .execute()
      for (const row of keys) {
        await tx
          .updateTable('scope_key_issuances')
          .set({ protected_token: null, retired_at: at })
          .where('account_id', '=', row.account_id)
          .where('grant_id', '=', row.grant_id)
          .where('attempt_id', '=', row.attempt_id)
          .execute()
        payloads++
      }
      const enrolments = await tx
        .selectFrom('scope_enrolment_results')
        .select(['account_id', 'attempt_id'])
        .where('grant_id', 'in', grants)
        .where('expires_at', '<=', at)
        .where('protected_token', 'is not', null)
        .limit(limit)
        .execute()
      for (const row of enrolments) {
        await tx
          .updateTable('scope_enrolment_results')
          .set({ protected_token: null, retired_at: at })
          .where('account_id', '=', row.account_id)
          .where('attempt_id', '=', row.attempt_id)
          .execute()
        payloads++
      }
      const trash = await tx
        .selectFrom('scope_trash')
        .select(['grant_id', 'file_id', 'interval_id'])
        .where('vault_id', '=', vault)
        .where('expires_at', '<=', at)
        .where('eligible', '=', 1)
        .limit(limit)
        .execute()
      for (const row of trash)
        await tx
          .updateTable('scope_trash')
          .set({ eligible: 0 })
          .where('grant_id', '=', row.grant_id)
          .where('file_id', '=', row.file_id)
          .where('interval_id', '=', row.interval_id)
          .execute()
      let feedQuery = tx
        .selectFrom('scope_feed_state')
        .select(['grant_id', 'generation', 'position', 'minimum_position'])
        .where('grant_id', 'in', grants)
        .orderBy('grant_id')
        .limit(65)
      if (options.afterGrant) feedQuery = feedQuery.where('grant_id', '>', options.afterGrant)
      const feeds = await feedQuery.execute(),
        feedBatch = feeds.slice(0, 64)
      for (const feed of feedBatch) {
        const cutoff = Math.max(feed.minimum_position, feed.position - feedKeep)
        await tx
          .deleteFrom('scope_feed')
          .where('grant_id', '=', feed.grant_id)
          .where('generation', '=', feed.generation)
          .where('position', '<=', cutoff)
          .execute()
        await tx
          .updateTable('scope_feed_state')
          .set({ minimum_position: cutoff })
          .where('grant_id', '=', feed.grant_id)
          .execute()
      }
      const progress = await tx
        .selectFrom('scope_group_progress')
        .select(['processed_seq', 'status', 'bootstrap_cursor'])
        .where('vault_id', '=', vault)
        .executeTakeFirst()
      if (
        progress &&
        (progress.bootstrap_cursor === null || progress.bootstrap_cursor === 'complete')
      ) {
        const dirty = await tx
          .selectFrom('scope_group_dirty')
          .select(['committed_seq', 'ordinal'])
          .where('vault_id', '=', vault)
          .where('committed_seq', '<=', progress.processed_seq)
          .orderBy('committed_seq')
          .limit(limit)
          .execute()
        for (const row of dirty) {
          await tx
            .deleteFrom('scope_group_dirty')
            .where('vault_id', '=', vault)
            .where('committed_seq', '=', row.committed_seq)
            .where('ordinal', '=', row.ordinal)
            .execute()
          removed++
        }
      }
      // Facts of pruned payload versions are not blob pins. Keep all current/native
      // authority, stable bindings, immutable origins and grant-local baseline rows.
      const stale = await tx
        .selectFrom('scope_group_parse_facts as fact')
        .leftJoin('versions as version', 'version.id', 'fact.version_id')
        .select(['fact.file_id', 'fact.version_id'])
        .where('fact.vault_id', '=', vault)
        .where('version.id', 'is', null)
        .limit(limit)
        .execute()
      for (const row of stale) {
        await tx
          .deleteFrom('scope_group_parse_facts')
          .where('vault_id', '=', vault)
          .where('file_id', '=', row.file_id)
          .where('version_id', '=', row.version_id)
          .execute()
        removed++
      }
      return {
        removed,
        payloads,
        nextGrant: feeds.length > 64 ? feedBatch.at(-1)!.grant_id : null,
        more:
          [
            snapshots,
            leases,
            uploads,
            entitlements,
            receipts,
            publications,
            keys,
            enrolments,
            trash,
            stale,
          ].some((rows) => rows.length === limit) || feeds.length > 64,
      }
    },
    (tx) => lockAccounts(tx, [owner.owner_account_id])
  )
}
/** Global orphan sweep: only safe direct upload-id directories, never symlinks.
 * Live reservations always remain, including another principal/vault's files.
 */
export async function cleanupScopedPartOrphans(deps: ScopedCleanupDeps, limit = 1000, after = '') {
  valid(limit)
  const root = join(deps.store.dir, 'scoped-upload-parts'),
    info = await partRootInfo(root)
  if (!info) return { removed: 0, next: null }
  const directory = await opendir(root)
  let removed = 0
  const page: string[] = []
  try {
    for await (const entry of directory) {
      if (!entry.isDirectory() || entry.name <= after || !/^[A-Za-z0-9_-]{1,200}$/.test(entry.name))
        continue
      page.push(entry.name)
      page.sort()
      if (page.length > limit + 1) page.pop()
    }
  } finally {
    await directory.close().catch(() => {})
  }
  for (const name of page.slice(0, limit)) {
    const row = await deps.db
      .selectFrom('scope_uploads')
      .select('id')
      .where('id', '=', name)
      .executeTakeFirst()
    if (row) continue
    if (await removeParts(deps, name)) removed++
  }
  return { removed, next: page.length > limit ? page[limit - 1]! : null }
}
