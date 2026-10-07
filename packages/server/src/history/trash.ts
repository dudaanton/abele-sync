import {
  AbeleError,
  caseKey,
  type Actor,
  type CommitOp,
  type CommitOpResult,
  type CommitResponse,
  type TrashItem,
} from '@abele/sync-protocol'
import { sql, type Kysely, type RawBuilder } from 'kysely'
import type { Database } from '../db/schema.js'
import { commitChosen, type CommitDeps } from '../oplog/commit.js'

/**
 * The trash: files whose head is a delete. A deleted file is still all of its
 * versions, so what the trash shows — and what a restore brings back — is the
 * last version that carried bytes, not the empty delete on top of it.
 */

/**
 * A `where` fragment over `versions as v`: this row is the newest version of
 * its file that has bytes — what the trash shows, and what a restore brings
 * back. A function, so that the usage totals can share it whichever of the two
 * modules the loader reaches first.
 */
export function lastWithContent(): RawBuilder<boolean> {
  return sql<boolean>`v.no = (select max(v2.no) from versions v2
    where v2.file_id = v.file_id and v2.blob_sha is not null)`
}

/** Everything in the trash, newest deletion first, under `pathPrefix` if one is given. */
export async function listTrash(
  db: Kysely<Database>,
  vaultId: string,
  pathPrefix?: string
): Promise<TrashItem[]> {
  let query = db
    .selectFrom('versions as v')
    .innerJoin('files as f', 'f.id', 'v.file_id')
    // The head of a file in the trash is its delete: who committed it deleted the file.
    .leftJoin('versions as d', 'd.id', 'f.head_version_id')
    .select([
      'f.id as file_id',
      'f.path as path',
      'f.kind as kind',
      'f.deleted_at as deleted_at',
      'v.id as last_version_id',
      'v.size as size',
      'd.actor_kind as deleted_by_kind',
      'd.actor_id as deleted_by_id',
      'd.actor_name as deleted_by_name',
    ])
    .where('f.vault_id', '=', vaultId)
    .where('f.deleted_at', 'is not', null)
    .where('v.blob_sha', 'is not', null)
    .where(lastWithContent())
    // A batch deletes several files at one timestamp; path keeps the order steady.
    .orderBy('f.deleted_at', 'desc')
    .orderBy('f.path')
  if (pathPrefix !== undefined && pathPrefix !== '') {
    // The case-folded path, so that the same prefix finds the same files on
    // sqlite (whose `like` folds ascii case) and on postgres (whose does not).
    const pattern = `${caseKey(pathPrefix).replace(/[!%_]/g, '!$&')}%`
    query = query.where(sql<boolean>`f.path_ci like ${pattern} escape '!'`)
  }

  const rows = await query.execute()
  return rows.flatMap((row) =>
    row.deleted_at === null
      ? []
      : [
          {
            file_id: row.file_id,
            path: row.path,
            kind: row.kind,
            deleted_at: row.deleted_at,
            last_version_id: row.last_version_id,
            size: row.size,
            deleted_by:
              row.deleted_by_kind === null ||
              row.deleted_by_id === null ||
              row.deleted_by_name === null
                ? null
                : { kind: row.deleted_by_kind, id: row.deleted_by_id, name: row.deleted_by_name },
          },
        ]
  )
}

/**
 * Bring a file back from the trash: a restore of the last version it had bytes
 * in — the same version the listing shows. It returns to its own path, or to
 * the next free name beside it when something else has taken it since.
 *
 * Only a file that is actually in the trash can come out of one. A live file is
 * `not_found` here rather than a restore of what it already shows: this route
 * is the trash, and it would otherwise write a version that changes nothing.
 *
 * The version is chosen under the vault's lock, beside the write, as the bulk route chooses
 * (`restoreDeletedMany`): chosen before it, another device could restore the file and edit it
 * in between, and the trashed bytes would then be written over that edit.
 */
export async function restoreDeleted(
  deps: CommitDeps,
  vaultId: string,
  actor: Actor,
  fileId: string
): Promise<CommitOpResult> {
  const { results } = await commitChosen(deps, vaultId, actor, async (trx) => {
    const version = await trx
      .selectFrom('versions as v')
      .innerJoin('files as f', 'f.id', 'v.file_id')
      .select('v.id as id')
      .where('f.vault_id', '=', vaultId)
      .where('f.id', '=', fileId)
      .where('f.deleted_at', 'is not', null)
      .where('v.blob_sha', 'is not', null)
      .where(lastWithContent())
      .executeTakeFirst()
    // Thrown, not answered: nothing is written yet, and the route says 404 as it always has.
    if (version === undefined) {
      throw new AbeleError('not_found', "nothing in this vault's trash under that file")
    }
    return [{ op: 'restore', file_id: fileId, version_id: version.id }]
  })
  const result = results[0]
  // One op in, one result out; anything else is the pipeline breaking its word.
  if (result === undefined) throw new Error('a trash restore answered with no result')
  return result
}

/**
 * Bring many files back from the trash in one commit, so every other
 * device receives them as one batch of the feed. Which of them are still in the trash is read
 * under the vault's lock, beside the writes: a file someone restored, and maybe edited, since
 * the list was drawn is `not_found` here rather than written over with its trashed version.
 * Each comes back as `restoreDeleted` brings one back: to its own path, or the next free name.
 */
export async function restoreDeletedMany(
  deps: CommitDeps,
  vaultId: string,
  actor: Actor,
  fileIds: string[]
): Promise<CommitResponse> {
  return commitChosen(deps, vaultId, actor, async (trx) => {
    const rows = await trx
      .selectFrom('versions as v')
      .innerJoin('files as f', 'f.id', 'v.file_id')
      .select(['f.id as file_id', 'v.id as version_id'])
      .where('f.vault_id', '=', vaultId)
      .where('f.id', 'in', fileIds)
      .where('f.deleted_at', 'is not', null)
      .where('v.blob_sha', 'is not', null)
      .where(lastWithContent())
      .execute()
    const last = new Map(rows.map((row) => [row.file_id, row.version_id]))
    return fileIds.map((fileId): CommitOp | CommitOpResult => {
      const versionId = last.get(fileId)
      return versionId === undefined
        ? {
            status: 'rejected',
            code: 'not_found',
            message: "nothing in this vault's trash under that file",
          }
        : { op: 'restore', file_id: fileId, version_id: versionId }
    })
  })
}
