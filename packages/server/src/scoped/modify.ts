import { AbeleError, CommitOpSchema } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { checkLimits } from '../oplog/commitHead.js'
import {
  applied,
  applyOp,
  headWins,
  keepBothSides,
  keepLoser,
  mergeOp,
} from '../oplog/commitWrite.js'
import { withScopedAuthority, type ScopedAuthority } from './authority.js'
import { loadScopedModify, type ScopedModify, type ScopedMergeInputDeps } from './mergeInputs.js'
import { lifecycleInTransaction } from './lifecycle.js'
import { denied, scopedOutputContext, serializeScopedResult } from './outputContext.js'
import { protectGroupField, groupKeys, groupRootPath } from './groups/writePolicy.js'
import { caseKey } from '@abele/sync-protocol'

/** Internal publication with scoped authorization and output checks. */
export async function commitScopedModify(
  deps: ScopedMergeInputDeps,
  token: string,
  vaultId: string,
  grantId: string,
  input: Omit<ScopedModify, 'op'>
) {
  return withScopedAuthority(
    deps,
    token,
    vaultId,
    grantId,
    'write',
    async (tx, a) => {
      const result = await modifyInTransaction(tx, a, deps, input)
      await tx
        .deleteFrom('scope_blob_uploads')
        .where('vault_id', '=', vaultId)
        .where('grant_id', '=', grantId)
        .where('principal_kind', '=', a.principal.kind)
        .where('principal_id', '=', a.principal.principal_id)
        .where('sha', '=', input.sha)
        .execute()
      const safe = await serializeScopedResult(tx, a, deps, result)
      if (safe.status === 'acknowledged') throw denied()
      return safe
    },
    { publishViewChanges: true }
  )
}
export async function modifyInTransaction(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  deps: ScopedMergeInputDeps,
  input: Omit<ScopedModify, 'op'>
) {
  if (!CommitOpSchema.safeParse({ op: 'modify', ...input }).success)
    throw new AbeleError('invalid_request', 'invalid scoped modify')
  const live = await tx
    .selectFrom('scope_current_members')
    .select('file_id')
    .where('grant_id', '=', a.principal.grant_id)
    .where('file_id', '=', input.file_id)
    .executeTakeFirst()
  if (!live) return lifecycleInTransaction(tx, a, deps, { op: 'modify', ...input })
  const { head, op, decision, baseVersion } = await loadScopedModify(tx, a, deps, input)
  const native = await tx
    .selectFrom('scope_native_files')
    .select('kind')
    .where('grant_id', '=', a.principal.grant_id)
    .where('file_id', '=', head.fileId)
    .executeTakeFirst()
  const protectedNote = head.kind === 'note' || native?.kind === 'note'
  if (head.kind !== 'note' && !native) throw denied()
  if (protectedNote && Math.max(input.size, head.size, baseVersion?.size ?? 0) > 8 * 1024 * 1024)
    throw new AbeleError('too_large', 'scoped prepared-note budget reached')
  const ctx = await scopedOutputContext(tx, a, deps)
  if (a.selector.kind === 'group' && protectedNote) {
    const current = await deps.store.get(head.sha!),
      incoming = await deps.store.get(input.sha)
    protectGroupField(current, incoming)
    const keys = groupKeys(incoming)
    ctx.allowGroupConflictCopy =
      keys.length === 1 && keys[0] === caseKey(await groupRootPath(tx, a))
  }
  try {
    await checkLimits(ctx, op, head)
  } catch (error) {
    if (error instanceof AbeleError)
      throw new AbeleError(error.code, 'scoped content budget unavailable')
    throw error
  }
  if (!(await deps.store.has(input.sha)) || (await deps.store.size(input.sha)) !== input.size)
    throw denied()
  const result = await (async () => {
    switch (decision.kind) {
      case 'apply':
        return applyOp(ctx, head, decision, op.base_version_id)
      case 'merge':
        return mergeOp(ctx, op, head)
      case 'conflict-file':
        return keepBothSides(ctx, op, head)
      case 'head-newer':
        return keepLoser(ctx, op, head)
      case 'head-wins':
        return headWins(head)
      case 'noop':
        return applied(head)
    }
  })()
  return result
}
