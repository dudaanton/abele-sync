import { z } from 'zod'
import {
  AbeleError,
  CommitOpSchema,
  ScopedCommitOpSchema,
  type ScopedCommitOp,
  normalisePath,
  type CommitOp,
  type CommitOpResult,
} from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { authNow } from '../auth/accounts.js'
import { checkLimits, pathTakenFor } from '../oplog/commitHead.js'
import { applyOp } from '../oplog/commitWrite.js'
import { fileKind } from '../oplog/kinds.js'
import { decide } from '../oplog/resolve.js'
import type { LoadedHead } from '../oplog/commitCtx.js'
import { withScopedAuthority, type ScopedAuthority } from './authority.js'
import { loadScopedModify, type ScopedMergeInputDeps } from './mergeInputs.js'
import { modifyInTransaction } from './modify.js'
import { lifecycleInTransaction } from './lifecycle.js'
import { nativeGroupNote, groupSponsor } from './groups/writePolicy.js'
import {
  denied,
  destinationAllowed,
  scopedOutputContext,
  serializeScopedResult,
} from './outputContext.js'

export function scopedOperations(input: unknown): ScopedCommitOp[] {
  const parsed = z.array(ScopedCommitOpSchema).min(1).max(32).safeParse(input)
  if (!parsed.success) throw new AbeleError('invalid_request', 'invalid scoped operations')
  const ops = parsed.data
  if (ops.some((op) => op.op === 'create' && 'prefer' in op))
    throw new AbeleError('invalid_request', 'scoped identity adoption is unavailable')
  return ops
}
/** Bounded atomic unit, with no partial result or numeric personal checkpoint. */
export async function commitScopedOperations(
  deps: ScopedMergeInputDeps,
  token: string,
  vaultId: string,
  grantId: string,
  input: unknown
) {
  const ops = scopedOperations(input)
  return withScopedAuthority(
    deps,
    token,
    vaultId,
    grantId,
    'write',
    async (tx, a) => {
      const results = await operationsInTransaction(tx, a, deps, ops)
      return {
        results: await Promise.all(
          results.map((result) => serializeScopedResult(tx, a, deps, result))
        ),
      }
    },
    { publishViewChanges: true }
  )
}
export async function operationsInTransaction(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  deps: ScopedMergeInputDeps,
  ops: ScopedCommitOp[]
) {
  const results: CommitOpResult[] = []
  const createShas = [...new Set(ops.flatMap((op) => (op.op === 'create' ? [op.sha] : [])))]
  const proofs = createShas.length
    ? await tx
        .selectFrom('scope_blob_uploads')
        .select(['sha', 'size', 'expires_at'])
        .where('vault_id', '=', a.principal.vault_id)
        .where('grant_id', '=', a.principal.grant_id)
        .where('principal_kind', '=', a.principal.kind)
        .where('principal_id', '=', a.principal.principal_id)
        .where('sha', 'in', createShas)
        .where('expires_at', '>', authNow(deps).toISOString())
        .execute()
    : []
  const bySha = new Map(proofs.map((row) => [row.sha, row]))
  // Reject every create without exact own live byte proof before any unit step
  // can calculate private vault usage or expose its limit decisions.
  for (const op of ops)
    if (op.op === 'create') {
      const proof = bySha.get(op.sha)
      if (
        !proof ||
        !proof.expires_at ||
        proof.expires_at <= authNow(deps).toISOString() ||
        proof.size !== op.size
      )
        throw denied()
    }
  let preparedNoteBytes = 0
  for (const op of ops) {
    if (op.op === 'modify') {
      const current = await tx
        .selectFrom('scope_current_members')
        .select('kind')
        .where('grant_id', '=', a.principal.grant_id)
        .where('file_id', '=', op.file_id)
        .executeTakeFirst()
      if (current?.kind === 'note') preparedNoteBytes += op.size
      if (preparedNoteBytes > 8 * 1024 * 1024)
        throw new AbeleError('too_large', 'scoped prepared-note budget reached')
      results.push(await modifyInTransaction(tx, a, deps, op))
      continue
    }
    if (op.op === 'delete' || op.op === 'restore') {
      results.push(await lifecycleInTransaction(tx, a, deps, op))
      continue
    }
    const sponsorId = op.op === 'create' ? op.sponsor_note_id : undefined
    const ctx = await scopedOutputContext(
      tx,
      a,
      deps,
      sponsorId,
      op.op === 'move' ? op.file_id : undefined
    )
    if (
      op.op === 'create' &&
      sponsorId &&
      (op.sponsor_version_id !== undefined || op.sponsor_admission_generation !== undefined)
    ) {
      const sponsor = await groupSponsor(ctx, a, sponsorId)
      if (
        sponsor.version_id !== op.sponsor_version_id ||
        sponsor.generation !== op.sponsor_admission_generation
      )
        throw new AbeleError('conflict', 'native sponsor preview changed')
    }
    const path = normalisePath(op.op === 'create' ? op.path : op.to_path)
    if (!(await destinationAllowed(ctx, a, path))) throw denied()
    if (op.op === 'create' && fileKind(path, ctx.settings) === 'note') preparedNoteBytes += op.size
    if (preparedNoteBytes > 8 * 1024 * 1024)
      throw new AbeleError('too_large', 'scoped prepared-note budget reached')
    let head: LoadedHead | null = null
    if (op.op === 'move') {
      const current = await tx
        .selectFrom('scope_current_members')
        .selectAll()
        .where('grant_id', '=', a.principal.grant_id)
        .where('vault_id', '=', a.principal.vault_id)
        .where('file_id', '=', op.file_id)
        .executeTakeFirst()
      if (!current || current.sha === null) throw denied()
      head = (
        await loadScopedModify(tx, a, deps, {
          file_id: op.file_id,
          base_version_id: op.base_version_id,
          sha: current.sha,
          size: current.size,
          mtime: current.mtime,
        })
      ).head
      if (
        head.kind !== 'note' &&
        !(await tx
          .selectFrom('scope_native_files')
          .select('file_id')
          .where('file_id', '=', head.fileId)
          .where('grant_id', '=', a.principal.grant_id)
          .executeTakeFirst())
      )
        throw denied()
    }
    let clean: ScopedCommitOp = op.op === 'create' ? { ...op, path } : { ...op, to_path: path }
    // Both identity and implicit-folder collisions have a generic refusal; never
    // ask the personal create loader to merge/adopt an occupied identity.
    try {
      const probe = head ?? ({ fileId: '', path } as LoadedHead)
      if (
        await pathTakenFor(
          ctx,
          { op: 'move', file_id: probe.fileId, base_version_id: '', to_path: path },
          probe
        )
      )
        throw denied()
      await checkLimits(ctx, clean, head)
    } catch (error) {
      if (error instanceof AbeleError) {
        if (error.code === 'path_taken' || error.code === 'not_found') throw denied()
        throw new AbeleError(error.code, 'scoped mutation unavailable')
      }
      throw error
    }
    if (op.op === 'create') {
      const proof = bySha.get(op.sha)
      if (
        !proof ||
        !proof.expires_at ||
        proof.expires_at <= authNow(deps).toISOString() ||
        proof.size !== op.size ||
        !(await deps.store.has(op.sha)) ||
        (await deps.store.size(op.sha)) !== op.size
      )
        throw denied()
      if (ctx.settings.max_file_bytes < op.size)
        throw new AbeleError('too_large', 'scoped file budget reached')
      if (a.selector.kind === 'group') {
        if (fileKind(path, ctx.settings) === 'note') {
          const bytes = await nativeGroupNote(ctx, a, await deps.store.get(op.sha))
          preparedNoteBytes += bytes.length - op.size
          if (preparedNoteBytes > 8 * 1024 * 1024)
            throw new AbeleError('too_large', 'scoped prepared-note budget reached')
          const stored = await deps.store.put(bytes)
          clean = { ...op, path, sha: stored.sha, size: stored.size }
          try {
            await checkLimits(ctx, clean, head)
          } catch (error) {
            if (error instanceof AbeleError)
              throw new AbeleError(error.code, 'normalized group note budget unavailable')
            throw error
          }
        } else {
          if (!sponsorId)
            throw new AbeleError('forbidden', 'an intrinsic native sponsor is required')
          await groupSponsor(ctx, a, sponsorId)
        }
      } else if (sponsorId) {
        if (fileKind(path, ctx.settings) === 'note')
          throw new AbeleError('invalid_request', 'folder notes must be intrinsic')
        await groupSponsor(ctx, a, sponsorId)
      }
    }
    const decision = decide(clean, head, ctx.settings, false)
    if (decision.kind !== 'apply') throw denied()
    results.push(
      await applyOp(ctx, head, decision, op.op === 'move' ? op.base_version_id : undefined)
    )
  }
  // Consume at the atomic unit boundary, including modify-over-delete. Every
  // operation keeps access to the original exact principal-owned byte evidence.
  const consumed = [...new Set(ops.flatMap((op) => ('sha' in op ? [op.sha] : [])))]
  if (consumed.length)
    await tx
      .deleteFrom('scope_blob_uploads')
      .where('vault_id', '=', a.principal.vault_id)
      .where('grant_id', '=', a.principal.grant_id)
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where('sha', 'in', consumed)
      .execute()
  return results
}
