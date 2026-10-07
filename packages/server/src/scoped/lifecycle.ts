import { AbeleError, type CommitOp } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { authNow } from '../auth/accounts.js'
import { checkLimits } from '../oplog/commitHead.js'
import { applied, applyOp, headWins } from '../oplog/commitWrite.js'
import { decide } from '../oplog/resolve.js'
import type { LoadedHead } from '../oplog/commitCtx.js'
import type { ScopedAuthority } from './authority.js'
import type { ScopedMergeInputDeps, ScopedModify } from './mergeInputs.js'
import { folderVersionInTransaction } from './admissions.js'
import { scopedUploadInTransaction } from './uploads.js'
import { denied, scopedOutputContext } from './outputContext.js'
import { currentGroupBytes, protectGroupField } from './groups/writePolicy.js'

type LifecycleOp = Extract<CommitOp, { op: 'delete' | 'restore' }> | ScopedModify
/** Retained, same-interval source first; only then inspect current identity metadata. */
async function lifecycleHead(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  deps: ScopedMergeInputDeps,
  op: LifecycleOp
): Promise<LoadedHead> {
  const sourceId = op.op === 'restore' ? op.version_id : op.base_version_id
  const source = await folderVersionInTransaction(tx, a, op.file_id, sourceId, authNow(deps), deps)
  const file = await tx
    .selectFrom('files')
    .selectAll()
    .where('vault_id', '=', a.principal.vault_id)
    .where('id', '=', op.file_id)
    .executeTakeFirst()
  if (!file?.head_version_id) throw denied()
  const current = await folderVersionInTransaction(
    tx,
    a,
    op.file_id,
    file.head_version_id,
    authNow(deps),
    deps
  )
  if (current.interval_id !== source.interval_id) throw denied()
  const versions = await tx
    .selectFrom('versions')
    .select(['id', 'seq', 'no', 'blob_sha', 'size', 'mtime', 'path'])
    .where('vault_id', '=', a.principal.vault_id)
    .where('file_id', '=', op.file_id)
    .where('id', 'in', [sourceId, file.head_version_id])
    .execute()
  const head = versions.find((row) => row.id === file.head_version_id),
    base = versions.find((row) => row.id === sourceId)
  if (!head || !base) throw denied()
  if (
    file.kind !== 'note' &&
    !(await tx
      .selectFrom('scope_native_files')
      .select('file_id')
      .where('grant_id', '=', a.principal.grant_id)
      .where('file_id', '=', file.id)
      .executeTakeFirst())
  )
    throw denied()
  return {
    fileId: file.id,
    path: file.path,
    kind: file.kind,
    deleted: file.deleted_at !== null,
    versionId: head.id,
    seq: head.seq,
    sha: head.blob_sha,
    size: head.size,
    mtime: head.mtime,
    no: head.no,
    baseIsKnown: 'yes',
    baseSha: base.blob_sha,
    basePath: base.path,
    baseSize: base.size,
    baseMtime: base.mtime,
    incoming: null,
    incomingVersion: false,
  }
}
export async function lifecycleInTransaction(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  deps: ScopedMergeInputDeps,
  op: LifecycleOp
) {
  const head = await lifecycleHead(tx, a, deps, op),
    ctx = await scopedOutputContext(tx, a, deps, undefined, head.fileId)
  if (op.op === 'modify') {
    if (!head.deleted) throw denied()
    const proof = await scopedUploadInTransaction(tx, a, op.sha, authNow(deps))
    if (
      proof.size !== op.size ||
      !(await deps.store.has(op.sha)) ||
      (await deps.store.size(op.sha)) !== op.size
    )
      throw denied()
  }
  if (
    head.kind === 'note' &&
    Math.max('size' in op ? op.size : 0, head.baseSize ?? 0) > 8 * 1024 * 1024
  )
    throw new AbeleError('too_large', 'scoped prepared-note budget reached')
  try {
    await checkLimits(ctx, op, head)
  } catch (error) {
    if (error instanceof AbeleError)
      throw new AbeleError(error.code, 'scoped lifecycle budget unavailable')
    throw error
  }
  const native = await tx
    .selectFrom('scope_native_files')
    .select('kind')
    .where('grant_id', '=', a.principal.grant_id)
    .where('file_id', '=', head.fileId)
    .executeTakeFirst()
  if (
    a.selector.kind === 'group' &&
    (head.kind === 'note' || native?.kind === 'note') &&
    op.op !== 'delete'
  ) {
    const current = await currentGroupBytes(ctx, a, head.fileId, head.sha)
    const incomingSha = op.op === 'modify' ? op.sha : head.baseSha
    if (!incomingSha) throw denied()
    protectGroupField(current, await deps.store.get(incomingSha))
  }
  const decision = decide(op, head, ctx.settings, false)
  if (decision.kind === 'head-wins') return headWins(head)
  if (decision.kind === 'noop') return applied(head)
  if (decision.kind !== 'apply') throw denied()
  if (
    decision.sha !== null &&
    (!(await deps.store.has(decision.sha)) ||
      (await deps.store.size(decision.sha)) !== decision.size)
  )
    throw denied()
  const result = await applyOp(
    ctx,
    head,
    decision,
    op.op === 'restore' ? op.version_id : op.base_version_id
  )
  return result
}
