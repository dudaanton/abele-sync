import type { ChangeItem, ChangesResponse, ManifestResponse } from '@abele/sync-protocol'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'

/** The sequence a vault has reached; 0 for a vault nothing has been committed to. */
export async function headSeqOf(db: Kysely<Database>, vaultId: string): Promise<number> {
  const row = await db
    .selectFrom('vault_seq')
    .select('head_seq')
    .where('vault_id', '=', vaultId)
    .executeTakeFirst()
  return row?.head_seq ?? 0
}

/**
 * The versions of one vault as change items: after `since`, at most `limit` of
 * them, in `order` of sequence. The feed reads them oldest first, the activity
 * list newest first; the rows and the mapping are the same either way.
 */
export async function changeItems(
  db: Kysely<Database>,
  vaultId: string,
  since: number,
  limit: number,
  order: 'asc' | 'desc'
): Promise<ChangeItem[]> {
  const rows = await db
    .selectFrom('versions')
    .innerJoin('files', 'files.id', 'versions.file_id')
    .select([
      'versions.seq as seq',
      'versions.file_id as file_id',
      'versions.op as op',
      'versions.path as path',
      'versions.prev_path as prev_path',
      'versions.blob_sha as blob_sha',
      'versions.size as size',
      'versions.mtime as mtime',
      'versions.id as version_id',
      'files.kind as kind',
      'versions.actor_kind as actor_kind',
      'versions.actor_id as actor_id',
      'versions.actor_name as actor_name',
      'versions.created_at as created_at',
    ])
    .where('versions.vault_id', '=', vaultId)
    .where('versions.seq', '>', since)
    .orderBy('versions.seq', order)
    .limit(limit)
    .execute()

  return rows.map((row) => ({
    seq: row.seq,
    file_id: row.file_id,
    op: row.op,
    path: row.path,
    prev_path: row.prev_path,
    sha: row.blob_sha,
    // A version without bytes (a delete) has no size or mtime to speak of.
    size: row.blob_sha === null ? null : row.size,
    mtime: row.blob_sha === null ? null : row.mtime,
    version_id: row.version_id,
    kind: row.kind,
    actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name },
    at: row.created_at,
  }))
}

/**
 * The versions committed after `since`, oldest first, at most `limit` of them.
 * `next_since` is where the next page starts: the last seq handed out, or
 * `since` itself when there was nothing to hand out.
 */
export async function changesSince(
  db: Kysely<Database>,
  vaultId: string,
  since: number,
  limit: number
): Promise<ChangesResponse> {
  const items = await changeItems(db, vaultId, since, limit, 'asc')
  const last = items[items.length - 1]
  return {
    items,
    head_seq: await headSeqOf(db, vaultId),
    next_since: last === undefined ? since : last.seq,
  }
}

/**
 * The live files in path order, `limit` at a time. `cursor` is the last path
 * of the previous page; `next` is this page's, or null once a page comes up
 * short and there is nothing after it.
 */
export async function manifest(
  db: Kysely<Database>,
  vaultId: string,
  cursor: string | null,
  limit: number
): Promise<ManifestResponse> {
  // The head first, then the files. A device follows the feed from the head this page
  // reports, so the head must not run ahead of the listing: a commit landing between the
  // two reads would then be in neither — not in the files, and behind where the feed
  // starts. Read this way round, such a commit is in the files, and in the feed as well,
  // where the device recognises the version and passes it over.
  const headSeq = await headSeqOf(db, vaultId)
  let query = db
    .selectFrom('files')
    .innerJoin('versions', 'versions.id', 'files.head_version_id')
    .select([
      'files.id as file_id',
      'files.path as path',
      'files.kind as kind',
      'versions.id as version_id',
      'versions.seq as seq',
      'versions.blob_sha as sha',
      'versions.size as size',
      'versions.mtime as mtime',
    ])
    .where('files.vault_id', '=', vaultId)
    .where('files.deleted_at', 'is', null)
    .where('versions.blob_sha', 'is not', null)
    .orderBy('files.path')
    .limit(limit)
  if (cursor !== null) query = query.where('files.path', '>', cursor)
  const rows = await query.execute()

  const items = rows.flatMap((row) =>
    row.sha === null
      ? []
      : [
          {
            file_id: row.file_id,
            path: row.path,
            kind: row.kind,
            version_id: row.version_id,
            seq: row.seq,
            sha: row.sha,
            size: row.size,
            mtime: row.mtime,
          },
        ]
  )
  const last = items[items.length - 1]
  return {
    items,
    next: items.length < limit || last === undefined ? null : last.path,
    head_seq: headSeq,
  }
}
