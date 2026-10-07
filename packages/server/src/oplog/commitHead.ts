import { AbeleError, caseKey, type CommitOp, type MergeInfo } from '@abele/sync-protocol'
import { sql } from 'kysely'
import { readJson } from '../db/json.js'
import type { Database } from '../db/schema.js'
import { corrupt, mergeBase, type ContentOp, type Ctx, type LoadedHead } from './commitCtx.js'
import type { BaseKnowledge, Decision } from './resolve.js'

/**
 * What an op meets before anything of it is written (see `commit.ts`): the file and the head it
 * names, the limits and the paths it runs into, and the bytes its decision will need.
 */

/* ── Loading the head ──────────────────────────────────────────────────── */

/**
 * The file the op names. A create looks the path up and finds only a live file
 * at that case key: a deleted one stays in the trash, and the create is a new
 * file beside it. Everything else names a file id, live or deleted, and a base:
 * looked up across the vault, so that a version of another file is told apart
 * from an id the vault has no row for at all.
 */
export async function loadHead(ctx: Ctx, op: CommitOp): Promise<LoadedHead | null> {
  const file = op.op === 'create' ? await fileAtPath(ctx, op.path) : await fileById(ctx, op.file_id)
  if (file === undefined) return null
  if (file.head_version_id === null) {
    throw corrupt(`file ${file.id} has no head version`)
  }

  const headVersion = await ctx.trx
    .selectFrom('versions')
    .select(['id', 'seq', 'no', 'blob_sha', 'size', 'mtime'])
    .where('id', '=', file.head_version_id)
    .executeTakeFirst()
  if (headVersion === undefined) {
    throw corrupt(`file ${file.id} points at a missing version`)
  }

  const baseId =
    op.op === 'restore' ? op.version_id : op.op === 'create' ? null : op.base_version_id
  const base =
    baseId === null
      ? undefined
      : await ctx.trx
          .selectFrom('versions')
          .select(['file_id', 'blob_sha', 'path', 'size', 'mtime'])
          .where('id', '=', baseId)
          .where('vault_id', '=', ctx.vaultId)
          .executeTakeFirst()
  const own = base !== undefined && base.file_id === file.id ? base : undefined
  const baseIsKnown: BaseKnowledge =
    base === undefined ? 'unknown' : own === undefined ? 'other-file' : 'yes'

  return {
    fileId: file.id,
    path: file.path,
    kind: file.kind,
    deleted: file.deleted_at !== null,
    versionId: headVersion.id,
    seq: headVersion.seq,
    sha: headVersion.blob_sha,
    size: headVersion.size,
    mtime: headVersion.mtime,
    no: headVersion.no,
    baseIsKnown,
    baseSha: own?.blob_sha ?? null,
    basePath: own?.path ?? null,
    ...(own === undefined ? {} : { baseSize: own.size, baseMtime: own.mtime }),
    ...((op.op === 'create' || op.op === 'modify') && op.sha !== headVersion.blob_sha
      ? await incomingSeen(ctx, file.id, op.sha, mergeBase(op, baseIsKnown))
      : { incoming: null }),
  }
}

/**
 * Whether a file has taken these bytes in before (see `HeadState.incoming`): a merge of it
 * that took them in from this base, else a version of it that holds them — and, apart from
 * that, whether a version holds them at all (`HeadState.incomingVersion`), which a merge does
 * not. Merges are few beside a file's versions, and the sha is matched in the query.
 */
async function incomingSeen(
  ctx: Ctx,
  fileId: string,
  sha: string,
  base: string | null
): Promise<{ incoming: 'merged' | 'version' | null; incomingVersion: boolean }> {
  const rows = await ctx.trx
    .selectFrom('versions')
    .select(['blob_sha', 'merge'])
    .where('file_id', '=', fileId)
    .where((eb) => eb.or([eb('blob_sha', '=', sha), eb('op', '=', 'merge')]))
    .execute()
  let merged = false
  let version = false
  for (const row of rows) {
    if (row.merge !== null) {
      const merge = readJson<MergeInfo>(row.merge)
      if (merge.incoming_sha === sha && merge.base_version_id === base) merged = true
    }
    if (row.blob_sha === sha) version = true
  }
  return { incoming: merged ? 'merged' : version ? 'version' : null, incomingVersion: version }
}

type FileRow = Pick<Database['files'], 'id' | 'path' | 'kind' | 'head_version_id' | 'deleted_at'>

const FILE_COLUMNS = ['id', 'path', 'kind', 'head_version_id', 'deleted_at'] as const

async function fileById(ctx: Ctx, fileId: string): Promise<FileRow | undefined> {
  return ctx.trx
    .selectFrom('files')
    .select(FILE_COLUMNS)
    .where('vault_id', '=', ctx.vaultId)
    .where('id', '=', fileId)
    .executeTakeFirst()
}

/** The live file at a path's case key, if there is one. */
async function fileAtPath(ctx: Ctx, path: string): Promise<FileRow | undefined> {
  return ctx.trx
    .selectFrom('files')
    .select(FILE_COLUMNS)
    .where('vault_id', '=', ctx.vaultId)
    .where('path_ci', '=', caseKey(path))
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

/* ── Limits and paths ──────────────────────────────────────────────────── */

/**
 * The file limit, then the vault quota counted against what the op would
 * replace. The bytes an op brings in are its own for a create or modify and the
 * restored version's for a restore; a delete and a move bring none.
 */
export async function checkLimits(ctx: Ctx, op: CommitOp, head: LoadedHead | null): Promise<void> {
  const size = incomingSize(op, head)
  if (size === null) return
  const { max_file_bytes, quota_bytes } = ctx.settings
  if (size > max_file_bytes) {
    throw new AbeleError('too_large', `the file is ${size} bytes; the limit is ${max_file_bytes}`, {
      size,
      max_file_bytes,
    })
  }
  if (quota_bytes === null) return
  const replaced = head !== null && !head.deleted ? head.size : 0
  const live = await liveBytes(ctx)
  if (live + size - replaced > quota_bytes) {
    throw new AbeleError('quota_exceeded', `the vault would hold more than ${quota_bytes} bytes`, {
      live_bytes: live,
      size,
      quota_bytes,
    })
  }
}

function incomingSize(op: CommitOp, head: LoadedHead | null): number | null {
  if (op.op === 'create' || op.op === 'modify') return op.size
  if (op.op === 'restore') return head?.baseSize ?? null
  return null
}

/** The bytes the live files hold right now, as the transaction sees them. */
export async function liveBytes(ctx: Ctx): Promise<number> {
  const row = await ctx.trx
    .selectFrom('files')
    .innerJoin('versions', 'versions.id', 'files.head_version_id')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('versions.size'), sql<number>`0`).as('total'))
    .where('files.vault_id', '=', ctx.vaultId)
    .where('files.deleted_at', 'is', null)
    .executeTakeFirst()
  // Postgres sums into a bigint, which its driver hands over as a string.
  return Number(row?.total ?? 0)
}

/**
 * Whether the path the op is headed for belongs to another live file: only a
 * move's target can be. A create found its collision while loading the head; a
 * modify and a delete stay put; a file coming back from the trash (a restore, or
 * a modify over a deleted head) takes the next free name in `applyOp` instead.
 */
export async function pathTakenFor(
  ctx: Ctx,
  op: CommitOp,
  head: LoadedHead | null
): Promise<boolean> {
  if (op.op === 'create') {
    if (await treeCollision(ctx, op.path, null)) {
      throw new AbeleError('path_taken', `a file or folder already occupies ${op.path}`)
    }
    return head !== null
  }
  if (op.op === 'move' && head !== null) {
    if (await treeCollision(ctx, op.to_path, head.fileId)) {
      throw new AbeleError('path_taken', `a file or folder already occupies ${op.to_path}`)
    }
    return liveFileAt(ctx, caseKey(op.to_path), head.fileId)
  }
  return false
}

async function liveFileAt(ctx: Ctx, key: string, exceptFileId: string): Promise<boolean> {
  const row = await ctx.trx
    .selectFrom('files')
    .select('id')
    .where('vault_id', '=', ctx.vaultId)
    .where('path_ci', '=', key)
    .where('deleted_at', 'is', null)
    .where('id', '!=', exceptFileId)
    .executeTakeFirst()
  return row !== undefined
}

/** A folder is implicit: no live file may occupy any ancestor or descendant of a file. */
async function treeCollision(ctx: Ctx, path: string, except: string | null): Promise<boolean> {
  const key = caseKey(path)
  const ancestors = key
    .split('/')
    .slice(0, -1)
    .map((_, i, parts) => parts.slice(0, i + 1).join('/'))
  const pattern = `${key.replace(/[!%_]/g, '!$&')}/%`
  let query = ctx.trx
    .selectFrom('files')
    .select('id')
    .where('vault_id', '=', ctx.vaultId)
    .where('deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        sql<boolean>`path_ci like ${pattern} escape '!'`,
        ...(ancestors.length === 0 ? [] : [eb('path_ci', 'in', ancestors)]),
      ])
    )
  if (except !== null) query = query.where('id', '!=', except)
  return (await query.executeTakeFirst()) !== undefined
}

/** A `nextFreeName` predicate including implicit folders as well as file paths. */
export async function takenPredicate(ctx: Ctx, _path: string): Promise<(key: string) => boolean> {
  const rows = await ctx.trx
    .selectFrom('files')
    .select('path_ci')
    .where('vault_id', '=', ctx.vaultId)
    .where('deleted_at', 'is', null)
    .execute()
  const keys = rows.map((row) => row.path_ci)
  return (key) =>
    keys.some((live) => live === key || live.startsWith(key + '/') || key.startsWith(live + '/'))
}

/* ── Small helpers ─────────────────────────────────────────────────────── */

/**
 * The bytes a decision will write must be in the store before anything about
 * the op is. The op's own sha may simply not have been uploaded yet, and the op
 * is refused with that; a move or a restore writes a sha some stored version
 * already names, and that one missing is the server's fault, not the client's.
 */
export async function requireBlobs(ctx: Ctx, op: CommitOp, decision: Decision): Promise<void> {
  const sha =
    decision.kind === 'apply'
      ? decision.sha
      : decision.kind === 'merge' ||
          decision.kind === 'conflict-file' ||
          decision.kind === 'head-newer'
        ? (op as ContentOp).sha
        : null
  if (sha === null) return
  if ('sha' in op && op.sha === sha) {
    // Possession of a digest is not possession of its bytes. Never consult the
    // shared store until this vault has proved ownership, even for a miss.
    const uploaded = await ctx.trx
      .selectFrom('blob_uploads')
      .select('sha')
      .where('vault_id', '=', ctx.vaultId)
      .where('sha', '=', sha)
      .limit(1)
      .executeTakeFirst()
    const named =
      uploaded ??
      (await ctx.trx
        .selectFrom('versions')
        .select('blob_sha')
        .where('vault_id', '=', ctx.vaultId)
        .where('blob_sha', '=', sha)
        .limit(1)
        .executeTakeFirst())
    if (named !== undefined && (await ctx.store.has(sha))) {
      const actual = await ctx.store.size(sha)
      if (op.size !== actual) {
        throw new AbeleError(
          'invalid_request',
          `size ${op.size} does not match blob size ${actual}`
        )
      }
      return
    }
    throw new AbeleError('not_found', `blob ${sha} has not been uploaded`, { sha })
  }
  if (await ctx.store.has(sha)) return
  throw corrupt(`blob ${sha} of a stored version is not in the store`)
}

/**
 * A blob a stored version names. It was counted in when that version was
 * written and retention keeps it for as long as the version, so not finding it
 * is a fault of the server's — a 500, not the store's `not_found`, which would
 * read to the client as something it could upload.
 */
export async function storedBlob(ctx: Ctx, sha: string, what: 'base' | 'head'): Promise<Buffer> {
  try {
    return await ctx.store.get(sha)
  } catch (error) {
    if (error instanceof AbeleError && error.code === 'not_found') {
      throw corrupt(`the ${what} blob ${sha} is not in the store`)
    }
    throw error
  }
}
