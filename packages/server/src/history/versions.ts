import {
  AbeleError,
  type Actor,
  type ChangeItem,
  type CommitOpResult,
  type MergeInfo,
  type VersionInfo,
} from '@abele/sync-protocol'
import type { Kysely } from 'kysely'
import { readJson } from '../db/json.js'
import type { Database } from '../db/schema.js'
import { changeItems } from '../oplog/changes.js'
import { commit, type CommitDeps } from '../oplog/commit.js'

/**
 * What the commit pipeline recorded, read back: a file's own versions, the
 * bytes any one of them held, and the whole vault's feed newest first.
 *
 * Every read is filtered by vault as well as by file. A file of another vault
 * is `not_found` rather than `forbidden`: the answer must not tell one vault
 * that a file id it guessed exists somewhere else.
 */

/** One file's versions, newest first. `before` is a version `no`, exclusive. */
export async function listVersions(
  db: Kysely<Database>,
  vaultId: string,
  fileId: string,
  opts: { limit: number; before?: number }
): Promise<VersionInfo[]> {
  await requireFile(db, vaultId, fileId)
  let query = db
    .selectFrom('versions')
    .select([
      'id',
      'no',
      'seq',
      'op',
      'path',
      'blob_sha',
      'size',
      'mtime',
      'actor_kind',
      'actor_id',
      'actor_name',
      'created_at',
      'merge',
    ])
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', fileId)
    .orderBy('no', 'desc')
    .limit(opts.limit)
  if (opts.before !== undefined) query = query.where('no', '<', opts.before)

  const rows = await query.execute()
  return rows.map((row) => ({
    version_id: row.id,
    no: row.no,
    seq: row.seq,
    op: row.op,
    path: row.path,
    sha: row.blob_sha,
    size: row.size,
    mtime: row.mtime,
    actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name },
    at: row.created_at,
    merge: row.merge === null ? null : readJson<MergeInfo>(row.merge),
  }))
}

/**
 * The bytes a version of this file points at, or null: a version of another
 * file (or another vault), and one that never had bytes of its own, both
 * amount to nothing to serve.
 */
export async function versionBlobSha(
  db: Kysely<Database>,
  vaultId: string,
  fileId: string,
  versionId: string
): Promise<string | null> {
  const row = await db
    .selectFrom('versions')
    .select('blob_sha')
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', fileId)
    .where('id', '=', versionId)
    .executeTakeFirst()
  return row?.blob_sha ?? null
}

/**
 * Put a version's content back at the head of its file. A restore is an
 * ordinary op, so it takes the vault lock, spends a seq and answers with the
 * result the commit pipeline would have given it — a rejection included.
 */
export async function restoreVersion(
  deps: CommitDeps,
  vaultId: string,
  actor: Actor,
  fileId: string,
  versionId: string
): Promise<CommitOpResult> {
  const { results } = await commit(deps, vaultId, actor, [
    { op: 'restore', file_id: fileId, version_id: versionId },
  ])
  const result = results[0]
  // One op in, one result out; anything else is the pipeline breaking its word.
  if (result === undefined) throw new Error('a restore commit answered with no result')
  return result
}

/**
 * The vault's change feed newest first: the newest `limit` versions with a seq
 * above `since`. That is `changes` reversed only while fewer than `limit` of
 * them follow `since`; past that the two pages are drawn from opposite ends.
 */
export async function activity(
  db: Kysely<Database>,
  vaultId: string,
  since: number,
  limit: number
): Promise<ChangeItem[]> {
  return changeItems(db, vaultId, since, limit, 'desc')
}

/** A file of this vault, live or deleted; anything else is not found here. */
async function requireFile(db: Kysely<Database>, vaultId: string, fileId: string): Promise<void> {
  const row = await db
    .selectFrom('files')
    .select('id')
    .where('vault_id', '=', vaultId)
    .where('id', '=', fileId)
    .executeTakeFirst()
  if (row === undefined) throw new AbeleError('not_found', 'no such file in this vault')
}
