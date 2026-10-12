import { createHash } from 'node:crypto'
import { caseKey, type CommitOpResult } from '@abele/sync-protocol'
import type { ConflictDivergencesTable } from '../db/schema.js'
import type { ContentOp, Ctx, LoadedHead } from './commitCtx.js'
import { loadHead, requireBlobs } from './commitHead.js'

/** Versioned, unambiguous branch identity. Expired base payloads do not change it. */
export function divergenceIdentity(vaultId: string, originalFileId: string, op: ContentOp) {
  const baseIdentity = op.op === 'create' ? 'create:v1' : `version:v1:${op.base_version_id}`
  return {
    divergence_key:
      'v1:' +
      createHash('sha256')
        .update(JSON.stringify([vaultId, originalFileId, baseIdentity, op.sha]))
        .digest('hex'),
    vault_id: vaultId,
    original_file_id: originalFileId,
    base_identity: baseIdentity,
    incoming_sha: op.sha,
  }
}

const unavailable = (): CommitOpResult => ({
  status: 'rejected',
  code: 'not_found',
  message: 'existing conflict outcome unavailable',
})

/** A colliding create has no wire file ID. Explicit locator evidence (not the generated
 * filename) keeps a lost submission attached to its original after that file moves.
 * Ambiguous reuse of an old path is refused, never assigned to a different original.
 */
export async function replayCreateDivergence(
  ctx: Ctx,
  op: Extract<ContentOp, { op: 'create' }>,
  head: LoadedHead | null
): Promise<CommitOpResult | undefined> {
  const sources = await ctx.trx
    .selectFrom('conflict_divergences')
    .select('original_file_id')
    .distinct()
    .where('vault_id', '=', ctx.vaultId)
    .where('base_identity', '=', 'create:v1')
    .where('create_path_ci', '=', caseKey(op.path))
    .where('incoming_sha', '=', op.sha)
    .limit(2)
    .execute()
  if (!sources.length) return undefined
  await requireBlobs(ctx, op, { kind: 'conflict-file', status: 'conflict' })
  if (sources.length !== 1 || (head && head.fileId !== sources[0]!.original_file_id))
    return unavailable()
  const original =
    head ??
    (await loadHead(
      ctx,
      { op: 'delete', file_id: sources[0]!.original_file_id, base_version_id: '' },
      false
    ))
  return original ? ((await replayDivergence(ctx, op, original)) ?? unavailable()) : unavailable()
}

/** Under source authority and the vault lock. Callers either already proved the bytes or
 * supply the personal proof callback. A miss preserves ordinary limits/proof ordering;
 * a hit must prove the input before returning any metadata. Never replay a raw response.
 */
export async function replayDivergence(
  ctx: Ctx,
  op: ContentOp,
  head: LoadedHead,
  prove?: () => Promise<void>
): Promise<CommitOpResult | undefined> {
  const row = await ctx.trx
    .selectFrom('conflict_divergences')
    .selectAll()
    .where('divergence_key', '=', divergenceIdentity(ctx.vaultId, head.fileId, op).divergence_key)
    .executeTakeFirst()
  if (!row) return undefined
  await prove?.()
  if (head.deleted || head.sha === null) return unavailable()
  if (ctx.conflictVisible && !(await ctx.conflictVisible(head.fileId, head.versionId)))
    return unavailable()
  const copy = await loadHead(
    ctx,
    { op: 'delete', file_id: row.conflict_file_id, base_version_id: row.conflict_version_id },
    false
  )
  // Legacy conflict responses carry no copy SHA/size. Their clients assume the copy
  // contains the submitted bytes; pointing them at edited bytes would corrupt their ledger.
  if (
    !copy ||
    copy.deleted ||
    copy.sha !== row.incoming_sha ||
    row.disposition === 'deleted' ||
    (ctx.conflictVisible && !(await ctx.conflictVisible(copy.fileId, copy.versionId)))
  ) {
    return unavailable()
  }
  return conflictResult(head, copy.fileId, copy.versionId, copy.path)
}

export function conflictResult(
  head: LoadedHead,
  fileId: string,
  versionId: string,
  path: string
): CommitOpResult {
  return {
    status: 'conflict',
    file_id: head.fileId,
    version_id: head.versionId,
    seq: head.seq,
    path: head.path,
    sha: head.sha!,
    size: head.size,
    mtime: head.mtime,
    conflict_path: path,
    conflict_file_id: fileId,
    conflict_version_id: versionId,
  }
}

export async function recordDivergence(
  ctx: Ctx,
  op: ContentOp,
  head: LoadedHead,
  copy: { fileId: string; versionId: string; path: string }
): Promise<void> {
  const row: ConflictDivergencesTable = {
    ...divergenceIdentity(ctx.vaultId, head.fileId, op),
    create_path_ci: op.op === 'create' ? caseKey(op.path) : null,
    conflict_file_id: copy.fileId,
    conflict_version_id: copy.versionId,
    first_head_version_id: head.versionId,
    chosen_path: copy.path,
    created_at: ctx.at.toISOString(),
    disposition: 'copy',
  }
  // A second writer cannot silently publish a copy: unique identity failure rolls back
  // the entire copy/admission/accounting/receipt transaction.
  await ctx.trx.insertInto('conflict_divergences').values(row).execute()
}
