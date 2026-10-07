import type { VaultSettings } from '@abele/sync-protocol'
import type { Kysely, Transaction } from 'kysely'
import { sweepIdempotency } from '../api/idempotency.js'
import { collectUnreferenced, hasWaitingEntitlement } from '../blobs/pending.js'
import { releaseRef, TOMBSTONE } from '../blobs/refs.js'
import type { BlobStore } from '../blobs/store.js'
import type { UploadManager } from '../blobs/uploads.js'
import type { Dialect } from '../db/connect.js'
import { readJson } from '../db/json.js'
import type { Database, RetentionClass } from '../db/schema.js'
import { withVaultLock } from '../oplog/lock.js'
import { getVaultSettings } from '../vault/vaults.js'
import { activeScopedPins } from './scopedPins.js'
import { cleanupScopedVault, cleanupScopedPartOrphans } from '../scoped/cleanup.js'

/**
 * The nightly sweep: history older than its vault's window goes, the blobs
 * nothing points at any more go with it, and abandoned uploads are cleared out.
 *
 * A vault is swept under its own lock, so a commit and a sweep never touch the
 * same file at once: a commit writes its version and only then stats the blob
 * it names, and a deletion landing between those two steps would leave a
 * version pointing at nothing.
 *
 * `versions.no` is never renumbered. A file that loses versions 1 and 2 still
 * has version 3 called 3, and a kept version's `prev_version_id` may name a
 * version that is gone — history reads as "this is where it came from, and that
 * far back is no longer kept" rather than as a lie about what happened.
 *
 * One vault's history is not another's: a vault that cannot be swept is logged
 * and stepped over, and the report counts what did come off.
 */
export interface RetentionReport {
  versions_removed: number
  blobs_removed: number
  /** Blobs no row stood for: uploads nobody committed within the day, and older strays. */
  unreferenced_removed: number
  uploads_swept: number
  idempotency_swept: number
}

export interface RetentionDeps {
  db: Kysely<Database>
  dialect: Dialect
  store: BlobStore
  uploads: UploadManager
  /** How long a stored answer is worth replaying; past it, the row is only weight. */
  idempotencyTtlMs: number
  now: () => Date
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** How long a blob nothing references waits before its bytes go. */
const BLOB_GRACE_MS = HOUR_MS
/** How long an upload nobody finished waits before its parts go. */
const UPLOAD_GRACE_MS = 24 * HOUR_MS
/** `delete ... in (?)` is a bind parameter per id; large sweeps go in batches. */
const DELETE_BATCH = 500

/**
 * Sweep every vault, then the blobs that fell out of them, then the stale
 * uploads, then the idempotency keys no retry can use any more.
 */
export async function runRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const now = deps.now()
  const vaults = await deps.db.selectFrom('vaults').select('id').orderBy('created_at').execute()

  let removed = 0
  for (const { id } of vaults) {
    try {
      removed += await withVaultLock(deps.db, deps.dialect, id, (trx) => sweepVault(trx, id, now))
      if (
        await deps.db
          .selectFrom('scope_grants')
          .select('id')
          .where('vault_id', '=', id)
          .limit(1)
          .executeTakeFirst()
      ) {
        let afterGrant: string | undefined
        do {
          const cleaned = await cleanupScopedVault(deps, id, { afterGrant })
          afterGrant = cleaned.nextGrant ?? undefined
        } while (afterGrant)
      }
    } catch (error) {
      console.error(`retention could not sweep vault ${id}:`, error)
    }
  }

  let afterPart = ''
  do {
    const cleaned = await cleanupScopedPartOrphans(deps, 1000, afterPart)
    afterPart = cleaned.next ?? ''
  } while (afterPart)
  return {
    versions_removed: removed,
    blobs_removed: await collectBlobs(deps, new Date(now.getTime() - BLOB_GRACE_MS)),
    unreferenced_removed: await collectUnreferenced(
      deps,
      new Date(now.getTime() - UPLOAD_GRACE_MS)
    ),
    uploads_swept: await deps.uploads.sweep(new Date(now.getTime() - UPLOAD_GRACE_MS)),
    idempotency_swept: await sweepIdempotency(
      deps.db,
      new Date(now.getTime() - deps.idempotencyTtlMs)
    ),
  }
}

/** One vault's history, inside its lock: what may go, goes, and its references are let go. */
async function sweepVault(trx: Transaction<Database>, vaultId: string, now: Date): Promise<number> {
  const settings = await getVaultSettings({ db: trx }, vaultId)
  const pins = await activeScopedPins(trx, vaultId, now)
  const files = await trx
    .selectFrom('files')
    .select(['id', 'head_version_id', 'deleted_at'])
    .where('vault_id', '=', vaultId)
    .execute()
  if (files.length === 0) return 0

  const versions = await trx
    .selectFrom('versions')
    .select([
      'id',
      'file_id',
      'no',
      'op',
      'blob_sha',
      'created_at',
      'prev_version_id',
      'merge',
      'retention_class',
    ])
    .where('vault_id', '=', vaultId)
    .execute()

  const keep = kept(files, versions, settings, now, pins)

  const expired = versions.filter((version) => !keep.has(version.id))
  for (const version of expired) {
    if (version.blob_sha !== null) await releaseRef(trx, version.blob_sha)
  }
  for (let from = 0; from < expired.length; from += DELETE_BATCH) {
    const batch = expired.slice(from, from + DELETE_BATCH).map((version) => version.id)
    await trx.deleteFrom('versions').where('id', 'in', batch).execute()
  }
  return expired.length
}

interface VersionRow {
  id: string
  file_id: string
  no: number
  op: string
  blob_sha: string | null
  created_at: string
  prev_version_id: string | null
  merge: string | null
  retention_class: RetentionClass | null
}

/**
 * Which versions this sweep leaves behind: everything inside its window, every
 * file's head, the last version a deleted file had bytes in, and — following
 * that set until it stops growing — whatever a kept version needs to be read.
 */
function kept(
  files: { id: string; head_version_id: string | null; deleted_at: string | null }[],
  versions: VersionRow[],
  settings: VaultSettings,
  now: Date,
  pins: ReadonlySet<string>
): Set<string> {
  const byId = new Map(versions.map((version) => [version.id, version]))
  const keep = new Set<string>()
  const add = (id: string | null | undefined): void => {
    if (id !== null && id !== undefined && byId.has(id)) keep.add(id)
  }

  const cutoffs = new Map<RetentionClass, string>()
  const cutoffFor = (category: RetentionClass): string => {
    let cutoff = cutoffs.get(category)
    if (cutoff === undefined) {
      const days = settings.retention[`${category}_days`]
      cutoff = new Date(now.getTime() - days * DAY_MS).toISOString()
      cutoffs.set(category, cutoff)
    }
    return cutoff
  }

  const fileIds = new Set(files.map((file) => file.id))
  for (const version of versions) {
    // Path changes, restores and scripts_folder changes cannot shorten older versions' windows.
    // Only the current numeric setting for the version's immutable class controls its age.
    const category = version.retention_class
    if (
      pins.has(version.id) ||
      !fileIds.has(version.file_id) ||
      category === null ||
      version.created_at >= cutoffFor(category)
    ) {
      keep.add(version.id)
    }
  }
  for (const file of files) {
    add(file.head_version_id)
    if (file.deleted_at !== null) add(lastWithContent(versions, file.id))
  }

  // The closure: a version kept for its own sake keeps what it is read through.
  const queue = [...keep]
  for (let at = 0; at < queue.length; at += 1) {
    const version = byId.get(queue[at]!)
    if (version === undefined) continue
    const needs = [mergeBase(version), version.op === 'restore' ? version.prev_version_id : null]
    for (const id of needs) {
      if (id === null || !byId.has(id) || keep.has(id)) continue
      keep.add(id)
      queue.push(id)
    }
  }
  return keep
}

/** The newest version of a file that had bytes: what the trash shows and a restore brings back. */
function lastWithContent(versions: VersionRow[], fileId: string): string | null {
  let best: VersionRow | undefined
  for (const version of versions) {
    if (version.file_id !== fileId || version.blob_sha === null) continue
    if (best === undefined || version.no > best.no) best = version
  }
  return best?.id ?? null
}

/** The version a merge was made against, from the provenance the merge wrote. */
function mergeBase(version: VersionRow): string | null {
  if (version.merge === null) return null
  const merge = readJson<{ base_version_id?: string | null }>(version.merge)
  return merge.base_version_id ?? null
}

/**
 * The blobs no version names any more. `last_referenced_at` moves whenever a
 * commit references a sha, so the hour's grace keeps a blob a commit has just
 * taken out of the scan altogether.
 *
 * Claim, deletion and row removal share one transaction. Other collectors and
 * commits cannot pass the claim until deletion finishes. A crash rolls back
 * the row, so absent bytes can be collected again. Tombstones left by older
 * builds are candidates too, regardless of age; the same row lock makes their
 * recovery exclusive. No timed lease can safely replace that exclusion.
 */
async function collectBlobs(deps: RetentionDeps, cutoff: Date): Promise<number> {
  const at = cutoff.toISOString()
  const candidates = await deps.db
    .selectFrom('blobs')
    .select('sha')
    .where((eb) =>
      eb.or([
        eb('refs', '=', TOMBSTONE),
        eb.and([eb('refs', '=', 0), eb('last_referenced_at', '<', at)]),
      ])
    )
    // A stable order, so that a sweep does the same thing twice over the same rows.
    .orderBy('sha')
    .execute()

  let removed = 0
  for (const { sha } of candidates) {
    try {
      const collected = await deps.db.transaction().execute(async (trx) => {
        // Hold the row through deletion. A second collector waits, then finds
        // no row; it can never delete a new upload after the first lets go.
        const claimed = await trx
          .updateTable('blobs')
          .set({ refs: TOMBSTONE })
          .where('sha', '=', sha)
          .where((eb) =>
            eb.or([
              eb('refs', '=', TOMBSTONE),
              eb.and([eb('refs', '=', 0), eb('last_referenced_at', '<', at)]),
            ])
          )
          .executeTakeFirst()
        if (Number(claimed.numUpdatedRows ?? 0n) === 0) return false
        if (await hasWaitingEntitlement(trx, sha, deps.now())) {
          await trx.updateTable('blobs').set({ refs: 0 }).where('sha', '=', sha).execute()
          return false
        }
        await deps.store.delete(sha)
        await trx.deleteFrom('blobs').where('sha', '=', sha).execute()
        return true
      })
      if (collected) removed++
    } catch (error) {
      // Rollback leaves the candidate recoverable, including when bytes went
      // but the DB commit did not. Deleting absent bytes is idempotent.
      console.error(`retention could not remove the bytes of blob ${sha}:`, error)
    }
  }
  return removed
}
