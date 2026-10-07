import {
  AbeleError,
  normalisePath,
  validatePath,
  type Actor,
  type CommitOp,
  type CommitOpResult,
  type CommitResponse,
  type Principal,
} from '@abele/sync-protocol'
import type { Kysely, Transaction } from 'kysely'
import type { BlobStore } from '../blobs/store.js'
import type { Dialect } from '../db/connect.js'
import { writeJson } from '../db/json.js'
import type { Database } from '../db/schema.js'
import type { EventHub } from '../events/hub.js'
import { newId } from '../ids.js'
import { getVaultSettings } from '../vault/vaults.js'
import { headSeqOf } from './changes.js'
import { corrupt, mustExist, type ContentOp, type Ctx, type LoadedHead } from './commitCtx.js'
import { checkLimits, loadHead, pathTakenFor, requireBlobs } from './commitHead.js'
import { applied, applyOp, headWins, keepBothSides, keepLoser, mergeOp } from './commitWrite.js'
import { fileAnswer, replayIfAnswered, type KeyedRun } from './keyed.js'
import { withVaultLock } from './lock.js'
import { decide, type Decision } from './resolve.js'

export interface CommitDeps {
  db: Kysely<Database>
  dialect: Dialect
  store: BlobStore
  hub: EventHub
  now?: () => Date
  writer?: Principal
  config?: { configurationDirectories?: readonly string[] }
  /**
   * The idempotency key the request came under, if any: looked up and answered inside the
   * commit's transaction (`keyed.ts`). A request already answered throws `Replay`.
   */
  keyed?: KeyedRun
}

/** Audit rows go in batches of this many, well under any dialect's parameter limit. */
const AUDIT_CHUNK = 100

/**
 * Commit a batch of ops from one actor. The whole batch runs under the vault's
 * lock in one transaction; each op is decided on its own, a rejected op never
 * aborts the others, and every op answers with exactly one result in order.
 */
export async function commit(
  deps: CommitDeps,
  vaultId: string,
  actor: Actor,
  ops: CommitOp[]
): Promise<CommitResponse> {
  return commitChosen(deps, vaultId, actor, async () => ops)
}

/**
 * A commit whose ops are chosen under the vault's lock, from what the vault holds at that
 * moment, so nothing another commit does can come between the choice and the write. `choose`
 * answers one item per result: an op to run, or a result that answers for itself and writes
 * nothing (the bulk trash restore's `not_found` for a file no longer in the trash).
 */
export async function commitChosen(
  deps: CommitDeps,
  vaultId: string,
  actor: Actor,
  choose: (trx: Transaction<Database>) => Promise<Array<CommitOp | CommitOpResult>>
): Promise<CommitResponse> {
  const at = deps.now?.() ?? new Date()
  const { ops, ran, results, headSeq, creationOutcomes } = await withVaultLock(
    deps.db,
    deps.dialect,
    vaultId,
    async (trx) => {
      if (deps.keyed !== undefined) await replayIfAnswered(trx, deps.keyed, at)
      const settings = await getVaultSettings({ db: trx }, vaultId)
      const ctx: Ctx = {
        trx,
        store: deps.store,
        vaultId,
        actor,
        settings,
        at,
        ...(deps.writer === undefined ? {} : { writer: deps.writer }),
        configurationDirectories: deps.config?.configurationDirectories,
      }
      const ops: CommitOp[] = []
      const ran: CommitOpResult[] = []
      const results: CommitOpResult[] = []
      for (const item of await choose(trx)) {
        if ('status' in item) {
          results.push(item)
          continue
        }
        const result = await runOp(ctx, item)
        ops.push(item)
        ran.push(result)
        results.push(result)
      }
      const headSeq = await headSeqOf(trx, vaultId)
      const creationOutcomes = results.flatMap((result, index) =>
        result.status !== 'rejected' && result.creation ? [{ index, kind: result.creation }] : []
      )
      const wireResults = results.map((result) => {
        if (result.status === 'rejected') return result
        const { creation: _internal, ...wire } = result
        return wire
      })
      if (deps.keyed !== undefined)
        await fileAnswer(
          trx,
          deps.keyed,
          {
            head_seq: headSeq,
            results: wireResults,
            ...(creationOutcomes.length ? { creation_outcomes: creationOutcomes } : {}),
          },
          at
        )
      return { ops, ran, results: wireResults, headSeq, creationOutcomes }
    }
  )
  if (deps.keyed !== undefined) deps.keyed.filed = true

  deps.hub.notify(vaultId, headSeq)
  // The commit has landed; a bookkeeping failure is logged, never sent back as one.
  try {
    // Only what ran is audited: an answer given without an op wrote nothing.
    await writeAudit(deps.db, vaultId, actor, ops, ran, at)
  } catch (error) {
    console.error(`audit rows for a commit to vault ${vaultId} were not written:`, error)
  }
  return {
    head_seq: headSeq,
    results,
    ...(creationOutcomes.length ? { creation_outcomes: creationOutcomes } : {}),
  }
}

/** What the pre-write phase settles about an op: the op as cleaned, its head, and what to do. */
interface Resolved {
  op: CommitOp
  head: LoadedHead | null
  decision: Decision
}

/** One op: decided while nothing is written, then carried out. */
async function runOp(ctx: Ctx, op: CommitOp): Promise<CommitOpResult> {
  const resolved = await resolveOp(ctx, op)
  if (resolved.decision.kind === 'reject') {
    return { status: 'rejected', code: resolved.decision.code, message: resolved.decision.message }
  }
  const result = await execute(ctx, resolved)
  if (op.op === 'create' && result.status !== 'rejected')
    return {
      ...result,
      creation:
        resolved.head === null
          ? 'novel'
          : resolved.decision.kind === 'noop'
            ? 'adopted'
            : 'collision',
    }
  return result
}

/**
 * The part of an op that may turn it down: paths, head, limits, the decision,
 * and the bytes the decision needs. Nothing has been written, so an `AbeleError`
 * here is this op's own result and the batch goes on. An `internal` error is not
 * the client's doing: it is rethrown and the whole batch answers 500.
 */
async function resolveOp(ctx: Ctx, op: CommitOp): Promise<Resolved> {
  try {
    const cleaned = cleanPaths(op)
    const head = await loadHead(ctx, cleaned)
    await checkLimits(ctx, cleaned, head)
    const taken = await pathTakenFor(ctx, cleaned, head)
    const decision = decide(cleaned, head, ctx.settings, taken)
    await requireBlobs(ctx, cleaned, decision)
    return { op: cleaned, head, decision }
  } catch (error) {
    if (error instanceof AbeleError && error.code !== 'internal') {
      const decision: Decision = { kind: 'reject', code: error.code, message: error.message }
      return { op, head: null, decision }
    }
    throw error
  }
}

/**
 * Carry a decision out. Nothing here is caught: an error after the first row
 * is written rolls the whole transaction back, so a batch either lands entire
 * or not at all, and no seq is ever spent on a version nobody can see.
 */
async function execute(ctx: Ctx, { op, head, decision }: Resolved): Promise<CommitOpResult> {
  switch (decision.kind) {
    case 'apply':
      return applyOp(
        ctx,
        head,
        decision,
        op.op === 'restore' ? op.version_id : op.op === 'modify' ? op.base_version_id : undefined
      )
    case 'merge':
      return mergeOp(ctx, op as ContentOp, mustExist(head))
    case 'conflict-file':
      // A copy the quota has no room for keeps the incoming text in history instead.
      return keepBothSides(ctx, op as ContentOp, mustExist(head))
    case 'head-wins':
      return headWins(mustExist(head))
    case 'head-newer':
      return keepLoser(ctx, op as ContentOp, mustExist(head))
    case 'noop':
      return applied(mustExist(head))
    case 'reject':
      return { status: 'rejected', code: decision.code, message: decision.message }
  }
}

/** Wire paths must already be relative and use forward slashes; reject before normalising. */
function cleanPaths(op: CommitOp): CommitOp {
  if (op.op === 'create') {
    validatePath(op.path)
    const path = normalisePath(op.path)
    return { ...op, path }
  }
  if (op.op === 'move') {
    validatePath(op.to_path)
    const to = normalisePath(op.to_path)
    return { ...op, to_path: to }
  }
  return op
}

/** One audit row per op, after the transaction: what was asked, and what came of it. */
async function writeAudit(
  db: Kysely<Database>,
  vaultId: string,
  actor: Actor,
  ops: CommitOp[],
  results: CommitOpResult[],
  at: Date
): Promise<void> {
  const rows = ops.map((op, i) => {
    const result = results[i]
    if (result === undefined) throw corrupt('an op without a result')
    return {
      id: newId(),
      vault_id: vaultId,
      actor_kind: actor.kind,
      actor_id: actor.id,
      action: op.op,
      path: auditPath(op, result),
      result: result.status === 'rejected' ? `rejected:${result.code}` : result.status,
      at: at.toISOString(),
      details: writeJson(result),
    }
  })
  for (let i = 0; i < rows.length; i += AUDIT_CHUNK) {
    await db
      .insertInto('audit')
      .values(rows.slice(i, i + AUDIT_CHUNK))
      .execute()
  }
}

/** The path an op was about: the one it named, else the one its result landed on. */
function auditPath(op: CommitOp, result: CommitOpResult): string | null {
  if (op.op === 'create') return op.path
  if (op.op === 'move') return op.to_path
  return result.status === 'rejected' ? null : result.path
}
