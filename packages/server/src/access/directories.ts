import { randomUUID } from 'node:crypto'
import { sql, type Selectable } from 'kysely'
import {
  AbeleError,
  caseKey,
  validatePath,
  type V2CommitOp,
  type CommitOp,
  type CommitOpResult,
} from '@abele/sync-protocol'
import type { Ctx } from '../oplog/commitCtx.js'
import { runEngineOp } from '../oplog/commit.js'
import { recordItem } from './visibility.js'
import type { AccessDeps } from './tokens.js'
import type { DirectoriesTable } from '../db/schemaAccess.js'

type DirectoryOp = Exclude<V2CommitOp, CommitOp>
type Directory = Selectable<DirectoriesTable>
const atPath = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/')
const parentPath = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/'
export async function liveDirectories(ctx: Ctx) {
  return ctx.trx
    .selectFrom('directories')
    .selectAll()
    .where('space_id', '=', ctx.vaultId)
    .where('deleted_at', 'is', null)
    .execute()
}
/** All collision checks happen before directory/tree writes. Exact case spelling is stable. */
export async function validateDestination(
  ctx: Ctx,
  path: string,
  directory: boolean,
  exceptPrefix?: string
) {
  validatePath(path)
  const key = caseKey(path)
  const dirs = await liveDirectories(ctx)
  for (const dir of dirs) {
    if (dir.path === '/' || (exceptPrefix && atPath(dir.path, exceptPrefix))) continue
    const other = caseKey(dir.path)
    if (
      (other === key && (!directory || dir.path !== path)) ||
      (key.startsWith(other + '/') && !path.startsWith(dir.path + '/')) ||
      other.startsWith(key + '/')
    )
      throw new AbeleError(
        'path_taken',
        'a directory or case-folded path occupies that destination'
      )
  }
  const files = await ctx.trx
    .selectFrom('files')
    .select(['path', 'path_ci'])
    .where('vault_id', '=', ctx.vaultId)
    .where('deleted_at', 'is', null)
    .execute()
  for (const file of files) {
    if (exceptPrefix && atPath(file.path, exceptPrefix)) continue
    if (
      (directory && file.path_ci === key) ||
      key.startsWith(file.path_ci + '/') ||
      file.path_ci.startsWith(key + '/')
    )
      throw new AbeleError('path_taken', 'a file occupies that destination or its ancestry')
  }
}
export async function nextSequence(ctx: Ctx) {
  return (
    await ctx.trx
      .updateTable('vault_seq')
      .set({ head_seq: sql<number>`head_seq + 1` })
      .where('vault_id', '=', ctx.vaultId)
      .returning('head_seq')
      .executeTakeFirstOrThrow()
  ).head_seq
}
const wire = (d: Directory) => ({
  file_id: d.id,
  path: d.path,
  version_id: d.version_id,
  kind: 'directory' as const,
  mtime: d.mtime,
})
async function record(ctx: Ctx, deps: AccessDeps, dir: Directory, deleted = false) {
  const seq = await nextSequence(ctx)
  await ctx.trx.updateTable('directories').set({ seq }).where('id', '=', dir.id).execute()
  await recordItem(
    { ...deps, db: ctx.trx },
    ctx.vaultId,
    wire(dir),
    seq,
    ctx.at.toISOString(),
    deleted
  )
  return seq
}
export async function ensureParents(ctx: Ctx, deps: AccessDeps, path: string, mtime: number) {
  const parent = parentPath(path)
  if (parent === '/') return
  await mkdir(ctx, deps, parent, mtime)
}
async function mkdir(
  ctx: Ctx,
  deps: AccessDeps,
  path: string,
  mtime: number
): Promise<CommitOpResult> {
  const existing = (await liveDirectories(ctx)).find((d) => d.path === path)
  if (existing) return answer(existing, existing.seq || (await record(ctx, deps, existing)))
  await ensureParents(ctx, deps, path, mtime)
  const parent = (await liveDirectories(ctx)).find((d) => d.path === parentPath(path))!
  const dir: Directory = {
    id: randomUUID(),
    space_id: ctx.vaultId,
    parent_id: parent.id,
    path,
    version_id: randomUUID(),
    seq: 0,
    mtime,
    deleted_at: null,
  }
  await ctx.trx.insertInto('directories').values(dir).execute()
  return answer(dir, await record(ctx, deps, dir))
}
function answer(dir: Directory, seq: number): CommitOpResult {
  return {
    status: 'applied',
    file_id: dir.id,
    version_id: dir.version_id,
    path: dir.path,
    sha: null,
    size: 0,
    mtime: dir.mtime,
    seq,
  }
}
export async function validateDirectoryOp(ctx: Ctx, op: DirectoryOp) {
  if (op.op === 'mkdir') {
    validatePath(op.path)
    if ((await liveDirectories(ctx)).some((d) => d.path === op.path)) return
    await validateDestination(ctx, op.path, true)
    return
  }
  const dir = (await liveDirectories(ctx)).find((d) => d.id === op.file_id)
  if (!dir || dir.path === '/')
    throw new AbeleError('not_found', 'no mutable directory in this scope')
  if (dir.version_id !== op.base_version_id)
    throw new AbeleError('invalid_request', 'directory base version is stale')
  if (op.op === 'move_directory') {
    if (op.to_path === dir.path) return
    if (atPath(op.to_path, dir.path))
      throw new AbeleError('invalid_request', 'cannot move a folder into itself')
    await validateDestination(ctx, op.to_path, true, dir.path)
    // An existing target folder is an obstacle, not a merge of directory identities.
    if (
      (await liveDirectories(ctx)).some(
        (d) => d.id !== dir.id && caseKey(d.path) === caseKey(op.to_path)
      )
    )
      throw new AbeleError('path_taken', 'destination directory already exists')
  }
}
export async function runDirectory(
  ctx: Ctx,
  deps: AccessDeps,
  op: DirectoryOp
): Promise<CommitOpResult> {
  if (op.op === 'mkdir') return mkdir(ctx, deps, op.path, op.mtime ?? ctx.at.getTime())
  const dirs = await liveDirectories(ctx)
  const source = dirs.find((d) => d.id === op.file_id)!
  if (op.op === 'move_directory' && source.path === op.to_path) return answer(source, source.seq)
  const descendants = dirs
    .filter((d) => atPath(d.path, source.path))
    .sort((a, b) => a.path.length - b.path.length)
  const files = await ctx.trx
    .selectFrom('files')
    .select(['id', 'path', 'head_version_id'])
    .where('vault_id', '=', ctx.vaultId)
    .where('deleted_at', 'is', null)
    .execute()
  if (op.op === 'move_directory') await ensureParents(ctx, deps, op.to_path, source.mtime)
  const parent =
    op.op === 'move_directory'
      ? (await liveDirectories(ctx)).find((d) => d.path === parentPath(op.to_path))!
      : undefined
  let result: CommitOpResult = answer(source, source.seq)
  // First update all identities, so their scopes follow the renamed root when file events land.
  for (const dir of descendants) {
    const updated = {
      ...dir,
      path: op.op === 'move_directory' ? op.to_path + dir.path.slice(source.path.length) : dir.path,
      version_id: randomUUID(),
      parent_id: dir.id === source.id && parent ? parent.id : dir.parent_id,
      deleted_at: op.op === 'delete_directory' ? ctx.at.toISOString() : null,
    }
    await ctx.trx
      .updateTable('directories')
      .set({
        path: updated.path,
        version_id: updated.version_id,
        parent_id: updated.parent_id,
        deleted_at: updated.deleted_at,
      })
      .where('id', '=', dir.id)
      .execute()
  }
  for (const file of files.filter((f) => atPath(f.path, source.path))) {
    const result = await runEngineOp(
      ctx,
      op.op === 'move_directory'
        ? {
            op: 'move',
            file_id: file.id,
            base_version_id: file.head_version_id!,
            to_path: op.to_path + file.path.slice(source.path.length),
          }
        : { op: 'delete', file_id: file.id, base_version_id: file.head_version_id! }
    )
    // Prevalidated tree writes must be all-or-nothing, not a partially applied directory.
    if (result.status === 'rejected')
      throw new Error(`prevalidated tree operation failed: ${result.code}`)
  }
  for (const dir of descendants) {
    const updated = await ctx.trx
      .selectFrom('directories')
      .selectAll()
      .where('id', '=', dir.id)
      .executeTakeFirstOrThrow()
    const seq = await record(ctx, deps, updated, op.op === 'delete_directory')
    if (dir.id === source.id) result = answer(updated, seq)
  }
  return result
}
