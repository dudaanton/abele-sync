import { AbeleError } from '@abele/sync-protocol'
import { sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import type { BlobStore } from './store.js'

/**
 * `blobs.refs` counts the versions that reference a sha — not the files, not the
 * requests, the versions. Two versions of the same note with the same bytes are
 * two references; history keeps a reference alive long after the file is gone.
 *
 * A count of zero means "no version points at this any more". A count of −1 is a
 * tombstone: retention has claimed the sha, its bytes are on their way off the
 * disk, and nothing may reference it again. A commit that meets a tombstone
 * fails — the batch rolls back whole and the client uploads the bytes again —
 * because the alternative is a version pointing at a file being deleted.
 *
 * The claim, the reference and the release are each one statement whose `where`
 * carries the rule, so two of them can never both believe they won. Nothing
 * here deletes: retention is the only thing that turns a tombstone into a
 * missing file, and it is the only thing that writes one.
 */

/** The `refs` value that says "being collected"; only retention writes it. */
export const TOMBSTONE = -1

/** Reference a blob from a version being committed: count one more, or make the row. */
export async function addRef(
  trx: Transaction<Database>,
  store: BlobStore,
  sha: string,
  size: number,
  at: string
): Promise<void> {
  // One statement settles the race: a tombstoned row matches nothing, so a blob
  // being collected cannot be counted back up under the collector.
  if (await countUp(trx, sha, at)) {
    await requireBytes(store, sha)
    return
  }

  // The row first, the bytes second. Made the other way round — look, then insert — the sweep
  // could claim the sha, remove its bytes and let the claim go between the two, and the row
  // would then stand for nothing. With the row in place first, the sweep's claim on the sha
  // conflicts with it (on Postgres it waits for this transaction and then finds it), and bytes
  // it removed before the row was made are caught by the look below, which rolls the row back.
  const inserted = await trx
    .insertInto('blobs')
    .values({
      sha,
      size,
      storage_ref: store.pathFor(sha),
      refs: 1,
      created_at: at,
      last_referenced_at: at,
    })
    .onConflict((oc) => oc.column('sha').doNothing())
    .executeTakeFirst()
  if (Number(inserted.numInsertedOrUpdatedRows ?? 0n) === 0) {
    // Another commit made the row since the count above: count against theirs. A tombstone
    // matches nothing there, and is the sweep's.
    if (await countUp(trx, sha, at)) {
      await requireBytes(store, sha)
      return
    }
    throw beingCollected(sha)
  }

  // A row pointing at bytes nobody uploaded would let a version reference nothing.
  await requireBytes(store, sha)
}

/** Ask only after acquiring the reference row, so a rolled-back GC cannot hide missing bytes. */
async function requireBytes(store: BlobStore, sha: string): Promise<void> {
  if (!(await store.has(sha))) {
    throw new AbeleError('not_found', `blob ${sha} has not been uploaded`, { sha })
  }
}

/** Let a version's reference go. The `where` is the floor, and it steps over a tombstone. */
export async function releaseRef(trx: Transaction<Database>, sha: string): Promise<void> {
  await trx
    .updateTable('blobs')
    .set({ refs: sql<number>`refs - 1` })
    .where('sha', '=', sha)
    // Above zero only: a count of zero stays zero, and a tombstone is not ours to move.
    .where('refs', '>', 0)
    .execute()
}

/** Count one more against a row that is not tombstoned. False if there was no such row. */
async function countUp(trx: Transaction<Database>, sha: string, at: string): Promise<boolean> {
  const bumped = await trx
    .updateTable('blobs')
    .set({ refs: sql<number>`refs + 1`, last_referenced_at: at })
    .where('sha', '=', sha)
    .where('refs', '>=', 0)
    .executeTakeFirst()
  return Number(bumped.numUpdatedRows ?? 0n) > 0
}

/**
 * The bytes are being collected. `not_found` and not `conflict`: as far as this
 * commit is concerned the blob is gone, and the answer a client can act on is
 * the one that tells it to upload the bytes again.
 */
const beingCollected = (sha: string): AbeleError =>
  new AbeleError('not_found', `blob ${sha} is being collected; upload it again`, { sha })
