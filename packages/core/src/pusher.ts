import { pathOccupant } from './pathOccupant.js'
import { replayAuthority } from './replayAuthority.js'
import { resolveLocalFile } from './localPaths.js'
import { transact, savepoint } from './stateTransaction.js'
import { isFileFailure, retryAttempt } from './fileRetry.js'
import {
  AbeleError,
  CommitOpSchema,
  CommitOpResultSchema,
  type CommitOpResult,
  type CommitOp,
  type CommitResponse,
  type ErrorCode,
  type JoinPrefer,
  type V2CommitOp,
} from '@abele/sync-protocol'
import { notifyApplied, type AppliedChange } from './applied.js'
import { pool } from './apply.js'
import type { CommitOutcome } from './engineClient.js'
import type { EngineClient } from './engineClient.js'
import type { ExpectedWrites } from './echo.js'
import { EngineError } from './errors.js'
import type { FileSystem } from './fs.js'
import { sha256 } from './hash.js'
import type { ScanFilter, ScanResult } from './scanner.js'
import { touchesDeferred, type Staged } from './defer.js'
import { batches, preferring } from './pushBatches.js'
import { PushDisk } from './pushDisk.js'
import { FINAL_REFUSALS, VerdictRecorder } from './pushRecord.js'
import { sourcesFromOps, sourcesFromScan, type Sources } from './pushSources.js'
import { TransferBudget } from './streaming.js'
import { VerdictPlanner } from './pushVerdicts.js'
import type { StateStore, StateEntry, Journal } from './state.js'
import { checkCancellation } from './cancellation.js'
import { isFinalForBatch } from './commitErrors.js'
import { rejectedOp } from './pushRefusal.js'
import { requestReconciliation } from './reconciliation.js'
import { isRecreatedTarget, sourceRecreation } from './sourceRecreation.js'
export { batches } from './pushBatches.js'

/**
 * The pusher: the scan's ops sent to the server, and the server's verdict brought back
 * onto this disk and into this state.
 *
 * One batch is one commit, and one commit is journalled: the ops and the idempotency key
 * are written down before a single byte is uploaded, and cleared only once every result
 * has been recorded, in the same transaction. A device that dies anywhere in between comes
 * back, finds the journal and sends the very same batch under the very same key — the
 * server hands back the answer it filed, or, if it never got as far as filing one, applies
 * the batch for the first time. Either way the vault gains one version, not two, which is
 * the whole reason the journal is written before the request rather than after it.
 *
 * Nothing here decides anything: the server settles every race, and the pusher only carries
 * the verdict out. A merge is downloaded and written; a conflict puts the head back where it
 * was and leaves the losing text to the copy the next pull brings; a refusal is reported and
 * the local file is left exactly as the scan found it.
 */

/** How many blobs are uploaded at once when the caller names no number. */
const DEFAULT_CONCURRENCY = 2

/** An op the server or host refused, and its explanation. Directories name their subtree. */
export interface RejectedOp {
  op: CommitOp | Extract<V2CommitOp, { op: 'mkdir' }>
  code: ErrorCode
  message: string
  /** Logical wire path, resolved per operation rather than from a blob digest. */
  path?: string
  size?: number
  /** Byte ceiling supplied by the server, or null when it was not disclosed. */
  limit?: number | null
}

/** What the server said when it refused some bytes for good: over the cap, or over the quota. */
export interface Refusal {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

/**
 * The refusals a whole batch is turned away with that will be the same next time: any 4xx
 * bar the ones that mean "not now" (`rate_limited`) or "not you" (`unauthorized`, `forbidden`,
 * which the engine halts on). A batch refused so is not journalled: replaying it would only
 * be refused again, before every pull, for ever.
 */

export interface PushReport {
  /** A retired unsafe request needs a fresh reconciliation/scan before new publication. */
  reconciliationRequired?: true
  /**
   * The last commit's answer, whose `head_seq` is where the vault stands after this push,
   * or null when there was nothing to commit.
   */
  committed: CommitResponse | null
  /** Ops the server took as they were sent. */
  applied: number
  /** Ops the server merged, or answered with a head that outlived them. */
  merged: number
  /** Ops whose bytes were copied aside, leaving the head where it was. */
  conflicts: number
  /** File refusals and refused mkdir subtrees. A mkdir has a path, no file id or sha. */
  rejected: RejectedOp[]
  /** True when the server read an answer back rather than applying a batch. */
  replayed: boolean
  /**
   * Wire paths whose verdict was recorded and not written, because the file changed while
   * the batch was in the air. The next scan pushes what is there now; until it does, the
   * puller must not write over it either, so the engine feeds these to its `dirty` set.
   */
  kept: string[]
  /**
   * Answers with the server's bytes for a path the host stages (`ResumeOptions.defer`) that were
   * staged rather than written, and were news — not staged already. Absent for none.
   */
  deferred?: number
}

/** What a replay needs: everything but the keys, which the journal already holds. */
export interface ResumeOptions {
  retries?: import('./fileRetry.js').FileRetries
  signal?: AbortSignal
  onApplied?: import('./applied.js').AppliedOptions['onApplied']
  transferBudget?: import('./streaming.js').TransferBudget
  /** The registry the host's watcher checks, so the engine does not push its own writes back. */
  expected: ExpectedWrites
  /** How many blobs to upload at once. */
  concurrency?: number
  /** The digest, `sha256` by default. Only local bytes are hashed, and only to check them. */
  hash?: (bytes: Uint8Array) => Promise<string>
  /**
   * sha → why the server refused it for good. Read before an upload and written after a
   * refusal; the engine owns the map and empties it when the cap or the quota changes.
   */
  refused?: Map<string, Refusal>
  /** Last learned server file ceiling, for refusals whose response omits details. */
  maxFileBytes?: number
  /**
   * Which files this device syncs at all. A verdict whose head this device does not sync —
   * over its size cap, most often, where the server's newer file won a race with a small local
   * one — is recorded against the local file and never written onto this disk.
   */
  filter?: ScanFilter
  /**
   * Which wire paths the host stages rather than has written (`EngineOptions.defer`). A verdict
   * that would write the server's bytes at one of them is staged instead (`pushStage.ts`): the
   * disk keeps what it sent, recorded against the version that holds it, and the head goes to
   * `onDefer`.
   */
  defer?: (wirePath: string) => boolean
  /**
   * Told of the heads a batch staged, each against the version its file's entry is recorded at.
   * Awaited before the batch's results are recorded, so a crash in between replays the batch and
   * stages them again. It may answer how many were news, which is what the report counts.
   */
  onDefer?: (staged: Staged[]) => number | void | Promise<number | void>
  /**
   * Told of each batch's ops once its commit has landed and its results are recorded — per
   * batch, so a push cut off after the first of several still reports what went out.
   * Runs before ledger publication: all state effects must use the supplied tx capability.
   */
  onCommitted?: (ops: readonly CommitOp[], tx: StateStore) => void | Promise<void>
  /**
   * How many of a batch's downloaded bytes — the heads its answers name — may be held before
   * they are written, as `PullOptions.prefetchBytes`: the batch is recorded in runs that fit,
   * one head bigger than the whole budget making a run of its own. 64 MiB when unset.
   */
  prefetchBytes?: number
  log?: (message: string) => void
}

export interface PushOptions extends ResumeOptions {
  /** Where idempotency keys come from; `crypto.randomUUID` when the caller names nothing. */
  keys?: () => string
  /**
   * The side every create of this push takes where the vault already has other bytes at its
   * path: the engine passes it only in a run that joined the vault (see
   * `EngineOptions.joinPrefer`). It goes into the ops before they are journalled, so a replay
   * sends exactly what was sent.
   */
  prefer?: JoinPrefer
  /**
   * Called with how many of this push's ops are not through yet, each time that falls: an op
   * with bytes once they are on the server, every op of a batch once the batch is recorded. For
   * a host counting "Syncing (N)" down; it ends at 0 once the push returns. A push that throws
   * leaves the count where it fell to, and the caller says what is left.
   */
  onProgress?: (left: number) => void
}

/**
 * Send what the scan found, and record what the server made of it.
 *
 * A journal still on disk is a batch whose answer was never written down, and it is settled
 * before anything new is sent: its report is the one this call goes on to fill in, so a
 * caller sees one account of everything that happened. The engine should call
 * `resumeJournal` itself, *before* it scans — a scan taken over an unrecorded batch describes
 * a disk the state does not know about yet — and the check here is the backstop that keeps a
 * `push` from writing over a journal it did not put there.
 *
 * With no ops there is still work: a file whose bytes did not change but whose mtime did
 * has to be written down as it now is, or every scan from here on will hash it again.
 */
export async function push(
  client: EngineClient,
  fs: FileSystem,
  state: StateStore,
  scan: ScanResult,
  opts: PushOptions
): Promise<PushReport> {
  const report = (await resumeJournal(client, fs, state, opts)) ?? emptyReport()
  if (report.reconciliationRequired) return report
  const pusher = new Pusher(client, fs, state, opts, report, scan.diskPaths)
  await pusher.refresh(scan)
  const newKey = opts.keys ?? (() => crypto.randomUUID())
  const sources = sourcesFromScan(fs, scan, state)
  const all = batches(await pusher.sendable(preferring(scan.ops, opts.prefer)))
  const progress = opts.onProgress
  if (progress !== undefined)
    pusher.countDown(
      all.reduce((sum, ops) => sum + ops.length, 0),
      progress
    )
  // A key of its own for every batch: two batches are two commits, and the server files
  // its answer to each under the key that batch was sent with.
  for (const ops of all) await pusher.batch(ops, newKey(), sources)
  pusher.finish()
  return report
}

/**
 * Settle a batch a crash left in the air, if there is one.
 *
 * The key is the journal's own: the server files an answer against a key only when it
 * answered 2xx, so sending the same batch again either reads that answer back — the vault
 * is already as the batch left it, and the results say how — or runs the batch for the
 * first time, because nothing was ever written under that key.
 */
export async function resumeJournal(
  client: EngineClient,
  fs: FileSystem,
  state: StateStore,
  opts: ResumeOptions
): Promise<PushReport | null> {
  const pending = await state.getJournal()
  if (!pending) return null
  const units = [pending]
  // Older servers discarded receipts after a day. They cannot distinguish a
  // never-applied join from an applied one whose answer was lost. Do not repeat
  // a destructive user choice after that window, even against an upgraded server
  // whose old receipt may already be gone. Archive the choice and reconcile neutrally.
  const report = emptyReport(),
    pusher = new Pusher(client, fs, state, opts, report, new Map())
  for (const journal of units) {
    const age = Date.now() - Date.parse(journal.startedAt)
    if (
      (!Number.isFinite(age) || age >= 24 * 60 * 60 * 1000) &&
      journal.ops.some((op) => op.op === 'create' && op.prefer === 'mine')
    ) {
      if (!state.getMeta || !state.setMeta)
        throw new EngineError(
          'conflict',
          'an expired local-preferred join requires durable review metadata'
        )
      // Request neutral reconciliation first: a crash after retirement must never start
      // a fresh prefer-mine batch under another key. Preserve the immutable old choice.
      await requestReconciliation(
        state,
        'expired local-preferred join requires current-state reconciliation'
      )
      await transact(state, async (tx) => {
        const key = `expired-journal:${journal.idempotencyKey}`
        const saved = await tx.getMeta!(key),
          raw = JSON.stringify(journal)
        if (saved !== null && saved !== raw)
          throw new EngineError('protocol', 'expired journal review identity mismatch')
        await tx.setMeta!(key, raw)
        await tx.setJournal(null)
        await tx.setCursor(0)
        await tx.setMeta!('pull-manifest-progress', null)
        await tx.setMeta!('pull-manifest-page', null)
      })
      return { ...emptyReport(), reconciliationRequired: true }
    }
    opts.log?.(`push: replaying ${journal.ops.length} ops under ${journal.idempotencyKey}`)

    await pusher.batch(
      journal.ops,
      journal.idempotencyKey,
      await sourcesFromOps(fs, state, journal.ops),
      journal.batchId,
      journal.startedAt,
      journal.origin
    )
  }
  return report
}

const emptyReport = (): PushReport => ({
  committed: null,
  applied: 0,
  merged: 0,
  conflicts: 0,
  rejected: [],
  replayed: false,
  kept: [],
})

/** Failed receipt placement is durable independently of the uncertain request
 * journal. It contains the server's answer, never a new commit to resend. */
interface RetainedReceipt {
  path: string
  op: CommitOp
  result: CommitOpResult
  /** Exact identity/base before settlement; absent only in legacy records. */
  base?: StateEntry | null
}
const receiptFields = ['path', 'wirePath', 'fileId', 'versionId', 'sha', 'size', 'mtime'] as const
async function receiptStillCurrent(
  fs: FileSystem,
  state: StateStore,
  row: RetainedReceipt
): Promise<boolean> {
  const id =
    row.result.status !== 'rejected'
      ? row.result.file_id
      : 'file_id' in row.op
        ? row.op.file_id
        : null
  const current = id === null ? await state.get(row.path) : await state.byFileId(id)
  if (row.result.status !== 'rejected') {
    if (current?.versionId === row.result.version_id) return false // already settled
    if (current === null && (await state.getCursor()) > row.result.seq) return false // later deletion
  }
  const expected =
    row.base !== undefined
      ? row.base
      : row.op.op === 'create'
        ? null
        : 'base_version_id' in row.op && id !== null
          ? { fileId: id, versionId: row.op.base_version_id }
          : null
  const destinations =
    row.result.status !== 'rejected'
      ? [
          { path: row.result.path, id: row.result.file_id, base: expected },
          ...(row.result.status === 'conflict'
            ? [{ path: row.result.conflict_path, id: row.result.conflict_file_id, base: null }]
            : []),
        ]
      : [
          {
            path: row.op.op === 'move' ? row.op.to_path : row.path || current?.path || '',
            id: id ?? '',
            base: expected,
          },
        ]
  for (const destination of destinations) {
    if (!destination.path) continue // a rejected operation with no remaining local identity
    let target: string
    try {
      target = await resolveLocalFile(fs, state, destination.path)
    } catch (error) {
      if (error instanceof AbeleError && error.code === 'path_taken') return false
      throw error
    }
    const source = destination.id === id ? current : await state.byFileId(destination.id)
    if (
      !replayAuthority(
        destination.id,
        destination.base,
        source,
        await pathOccupant(fs, state, target, destination.id)
      )
    )
      return false
  }
  if (row.base !== undefined)
    return row.base === null || current === null
      ? row.base === current
      : receiptFields.every((field) => row.base![field] === current[field])
  // Old receipts had no snapshot. Their submitted version is the only authority
  // they can retain; a create cannot overwrite an identity now tracked elsewhere.
  return row.op.op === 'create'
    ? current === null
    : 'base_version_id' in row.op && current?.versionId === row.op.base_version_id
}

export async function resumeReceipts(
  client: EngineClient,
  fs: FileSystem,
  state: StateStore,
  opts: ResumeOptions
): Promise<void> {
  if (!opts.retries) return
  for (const key of (await state.metadataKeys?.('push-receipt:')) ?? []) {
    checkCancellation(opts.signal)
    const raw = await state.getMeta?.(key)
    if (!raw) continue
    let row: RetainedReceipt
    try {
      const value = JSON.parse(raw)
      row = {
        path: value.path,
        op: CommitOpSchema.parse(value.op),
        result: CommitOpResultSchema.parse(value.result),
        ...(value.base === undefined ? {} : { base: value.base }),
      }
      if (typeof row.path !== 'string') throw new Error('invalid receipt path')
      if (
        row.base !== undefined &&
        row.base !== null &&
        !receiptFields.every(
          (field) =>
            typeof row.base![field] ===
            (field === 'size' || field === 'mtime' ? 'number' : 'string')
        )
      )
        throw new Error('invalid receipt base')
    } catch (error) {
      await opts.retries.failed(key, 'recovery', error, true)
      continue
    }
    if (!opts.retries.ready(row.path)) continue
    const pusher = new Pusher(client, fs, state, opts, emptyReport(), new Map())
    await pusher.receipt(key, row)
  }
}

/** One run of the pusher: the adapters, the options and the report it is filling in. */
class Pusher {
  private readonly transferBudget: TransferBudget
  /** How many ops of this push are not through yet, and who is told as it falls. */
  private left = 0
  private progress: ((left: number) => void) | null = null
  private readonly hash: (bytes: Uint8Array) => Promise<string>
  private readonly concurrency: number
  private readonly refused: Map<string, Refusal>
  /**
   * sha → the server's word that other uploads of the vault fill its quota for now
   * (`quota_waiting`). Left out of this push like a refusal, but for this push only: the next
   * one uploads them again, by when those uploads may be committed or given up on.
   */
  private readonly waiting = new Map<string, Refusal>()
  private readonly planner: VerdictPlanner
  private readonly recorder: VerdictRecorder

  constructor(
    private readonly client: EngineClient,
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: ResumeOptions,
    private readonly report: PushReport,
    /** wirePath → the on-disk spelling, as the scan found it; empty on a replay. */
    diskPaths: Map<string, string>
  ) {
    this.hash = opts.hash ?? sha256
    this.transferBudget = opts.transferBudget ?? new TransferBudget()
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    this.refused = opts.refused ?? new Map()
    const disk = new PushDisk(fs, state, opts, this.hash, diskPaths)
    this.planner = new VerdictPlanner(client, fs, state, opts, this.hash, this.concurrency, disk)
    this.recorder = new VerdictRecorder(fs, state, opts, report, this.hash, this.refused, disk)
  }

  async receipt(key: string, row: RetainedReceipt): Promise<void> {
    if (!(await receiptStillCurrent(this.fs, this.state, row))) {
      await transact(this.state, async (tx) => {
        await tx.setMeta?.(key, null)
        await this.opts.retries?.succeeded(row.path, 'recovery', tx)
        await this.opts.retries?.succeeded(key, 'recovery', tx)
      })
      await this.opts.retries?.load()
      return
    }
    const verdicts = await this.planner.plan([row.op], [row.result])
    try {
      const previous = row.op.op === 'create' ? null : await this.state.byFileId(row.op.file_id)
      const keptBefore = this.report.kept.length
      if (verdicts.failures?.has(0)) throw verdicts.failures.get(0)
      if (verdicts.staged.size) await this.opts.onDefer?.([...verdicts.staged.values()])
      let current = false
      await transact(this.state, async (tx) => {
        current = await receiptStillCurrent(this.fs, tx, row)
        if (current) await this.recorder.withState(tx).take(row.op, row.result, 0, verdicts)
        await tx.setMeta?.(key, null)
        await this.opts.retries?.succeeded(row.path, 'recovery', tx)
        await this.opts.retries?.succeeded(key, 'recovery', tx)
      })
      await this.opts.retries?.load()
      const result = row.result
      if (
        current &&
        result.status !== 'rejected' &&
        !verdicts.bad.has(0) &&
        !verdicts.staged.has(0) &&
        !verdicts.stale.has(0) &&
        !verdicts.aside.has(0) &&
        this.report.kept.length === keptBefore &&
        !touchesDeferred(
          this.opts.defer,
          result.path,
          previous?.wirePath,
          result.status === 'conflict' ? result.conflict_path : null
        )
      ) {
        await notifyApplied(this.opts, {
          path: result.path,
          origin: 'local',
          fileId: result.file_id,
          kind:
            row.op.op === 'delete' && result.status === 'applied'
              ? 'delete'
              : row.op.op === 'move'
                ? 'move'
                : 'upsert',
          ...(row.op.op === 'move' && previous ? { from: previous.wirePath } : {}),
        })
      }
    } catch (error) {
      checkCancellation(this.opts.signal)
      if (!this.opts.retries || !isFileFailure(error)) throw error
      await this.opts.retries.failed(row.path, 'recovery', error, false, this.state, key)
    } finally {
      await this.planner.discardStages(verdicts)
    }
  }

  private async retainReceipt(
    op: CommitOp,
    result: CommitOpResult,
    error: unknown,
    tx: StateStore
  ): Promise<void> {
    if (!this.opts.retries || !isFileFailure(error)) throw error
    const path =
      op.op === 'create'
        ? op.path
        : op.op === 'move'
          ? op.to_path
          : (await tx.byFileId(op.file_id))?.wirePath
    if (path === undefined) throw error
    const identity =
      result.status !== 'rejected' ? result.file_id : 'file_id' in op ? op.file_id : path
    const base = await tx.byFileId(identity)
    await tx.setMeta!(
      `push-receipt:${encodeURIComponent(identity)}`,
      JSON.stringify({ path, op, result, base })
    )
    await this.opts.retries.failed(
      path,
      'recovery',
      error,
      false,
      tx,
      `push-receipt:${encodeURIComponent(identity)}`
    )
    this.report.kept.push(path)
  }

  /**
   * The ops worth sending: every one whose bytes the server has not already refused for
   * good. The rest are reported refused in the server's own words, without a request — the
   * file stays as it is, the engine keeps its path clear of the pulls, and the next scan
   * offers it again, to be turned away here again until its bytes or the cap change.
   */
  async sendable(ops: CommitOp[], checkPaths = true): Promise<CommitOp[]> {
    const kept: CommitOp[] = []
    for (const op of ops) {
      const path =
        (checkPaths && this.client.pathRefusal) || this.opts.retries
          ? op.op === 'create'
            ? op.path
            : op.op === 'move'
              ? op.to_path
              : (await this.state.byFileId(op.file_id))?.wirePath
          : undefined
      const refusal =
        (path === undefined ? undefined : this.client.pathRefusal?.(path)) ??
        ('sha' in op ? this.refused.get(op.sha) : undefined)
      const wait = 'sha' in op ? this.waiting.get(op.sha) : undefined
      if (refusal === undefined && wait === undefined) {
        if (
          checkPaths &&
          path !== undefined &&
          this.opts.retries &&
          !this.opts.retries.ready(path, 'push', retryAttempt(op))
        ) {
          this.report.kept.push(path)
          continue
        }
        kept.push(op)
        continue
      }
      const said = refusal ?? wait
      if (said === undefined) continue
      const rejected = await rejectedOp(this.state, op, said, this.opts.maxFileBytes)
      this.report.rejected.push(rejected)
      this.opts.log?.(
        `push: ${op.op} refused: ${said.code} ${rejected.message} ` +
          (refusal === undefined ? '(sent again next time)' : '(not sent again)')
      )
    }
    return kept
  }

  /**
   * One batch: journalled, uploaded, committed, recorded, and the journal cleared with the
   * record in one transaction.
   *
   * Everything throws outward. An upload that fails leaves the journal with nothing sent,
   * so a replay uploads again; a commit that fails leaves it with nothing recorded, so a
   * replay sends the same batch under the same key; a record that fails rolls the state
   * back to before it, journal included, so a replay reads the server's filed answer back
   * and records it properly. There is no state in which a batch is forgotten.
   *
   * Two refusals are the exception, because replaying them would only be refused again: an
   * upload the server turns away for good takes its ops out of the batch, and a batch the
   * server turns away as a whole is reported refused and its journal cleared.
   */
  /** Count `total` ops down from here, telling `progress` each time the count falls. */
  countDown(total: number, progress: (left: number) => void): void {
    this.left = total
    this.progress = progress
  }

  /** The push is over: nothing of it is left to count. */
  finish(): void {
    this.fall(this.left)
  }

  private fall(by: number): void {
    if (this.progress === null || by <= 0) return
    this.left = Math.max(0, this.left - by)
    this.progress(this.left)
  }

  async batch(
    ops: CommitOp[],
    key: string,
    sources: Sources,
    batchId?: string,
    startedAt?: string,
    origin?: Journal['origin']
  ): Promise<void> {
    // Refused or recorded, a batch's ops are through once it has returned.
    const after = this.left - ops.length
    await this.sendBatch(ops, key, sources, batchId, startedAt, origin)
    this.fall(this.left - after)
  }

  private async sendBatch(
    ops: CommitOp[],
    key: string,
    sources: Sources,
    batchId?: string,
    startedAt?: string,
    origin?: Journal['origin']
  ): Promise<void> {
    checkCancellation(this.opts.signal)
    const journal: Journal = {
      ...(startedAt === undefined
        ? {
            origin: {
              cursor: await this.state.getCursor(),
              generation: (await this.state.getMeta?.('server-restore-generation')) ?? null,
            },
          }
        : origin === undefined
          ? {}
          : { origin }),
      batchId: batchId ?? crypto.randomUUID(),
      ops,
      idempotencyKey: key,
      startedAt: startedAt ?? new Date().toISOString(),
    }
    await this.state.setJournal(journal)
    await this.upload(ops, sources)
    // Path refusals filter fresh work before journaling. An uncertain old request
    // must replay unchanged, even if a later mkdir was refused for its parent.
    const sending = await this.sendable(ops, false)
    if (sending.length === 0) {
      await this.state.setJournal(null)
      return
    }
    if (sending.length !== ops.length) await this.state.setJournal({ ...journal, ops: sending })

    let outcome: CommitOutcome
    try {
      outcome = await this.client.commitRaw(sending, key)
    } catch (error) {
      if (!(error instanceof AbeleError) || !isFinalForBatch(error)) throw error
      this.opts.log?.(
        `push: the server refused the batch of ${sending.length}: ${error.code} ${error.message}`
      )
      for (const op of sending) {
        this.report.rejected.push(await rejectedOp(this.state, op, error, this.opts.maxFileBytes))
      }
      await this.state.setJournal(null)
      return
    }
    this.report.committed = outcome.body
    if (outcome.replayed) this.report.replayed = true

    const results = outcome.body.results
    if (results.length !== sending.length) {
      throw new EngineError(
        'protocol',
        `the commit answered ${results.length} results for ${sending.length} ops`
      )
    }
    const superseded = new Set<number>()
    const countSuperseded = async (at: number, state = this.state) => {
      const result = results[at]!
      // Reports count acknowledged answers, including already-settled replay,
      // without granting the old answer authority to mutate the current file.
      if (result.status === 'rejected')
        this.report.rejected.push(
          await rejectedOp(state, sending[at]!, result, this.opts.maxFileBytes)
        )
      else if (result.status === 'applied') this.report.applied++
      else if (result.status === 'merged') this.report.merged++
      else this.report.conflicts++
    }
    // A recovered local journal is a replay even if the server had not received
    // the original request. Its answer cannot authorize an older local baseline.
    const replay = outcome.replayed || startedAt !== undefined
    if (replay) {
      const releasing = new Set<string>()
      for (const [at, op] of sending.entries()) {
        const result = results[at]!
        const path = result.status !== 'rejected' ? result.path : op.op === 'create' ? op.path : ''
        // An earlier move releases this recreated source's ledger slot. Validate
        // its create inside settlement, after that move. The per-record replay
        // fence still applies and refuses a slot that was not actually released.
        if (op.op === 'create' && releasing.has(op.path)) continue
        if (!(await receiptStillCurrent(this.fs, this.state, { op, result, path }))) {
          superseded.add(at)
          await countSuperseded(at)
        } else if (
          op.op === 'move' &&
          result.status === 'applied' &&
          result.file_id === op.file_id &&
          result.path === op.to_path
        ) {
          const base = await this.state.byFileId(op.file_id)
          if (
            base !== null &&
            isRecreatedTarget(await sourceRecreation(this.state, base), op.to_path)
          )
            releasing.add(base.wirePath)
        }
      }
    }
    const verdicts = await this.planner.plan(sending, results, superseded)
    try {
      if (verdicts.staged.size > 0) {
        const heads = [...verdicts.staged.values()]
        for (const { change } of heads) {
          this.opts.log?.(
            `push: the vault keeps ${change.actor.name}'s ${change.path}; staged, not written`
          )
        }
        const fresh = await this.opts.onDefer?.(heads)
        this.report.deferred =
          (this.report.deferred ?? 0) + (typeof fresh === 'number' ? fresh : heads.length)
      }
      const applied: AppliedChange[] = []
      let recorded = 0
      let interrupted = false
      await transact(this.state, async (tx) => {
        const recorder = this.recorder.withState(tx)
        for (const [k, run] of verdicts.runs.entries()) {
          if (k > 0) {
            if (this.opts.signal?.aborted) {
              interrupted = true
              return
            }
            try {
              await this.planner.fetchRun(run, verdicts, tx)
            } catch (error) {
              // Download cancellation must not roll back files already recorded by this batch.
              if (!this.opts.signal?.aborted) throw error
              interrupted = true
              return
            }
          }
          for (const at of run) {
            // Commit completed ledger entries even when the remaining verdicts are cancelled.
            // Keep the journal: resume replays the same server receipt for the rest.
            if (recorded > 0 && this.opts.signal?.aborted) {
              interrupted = true
              return
            }
            const op = sending[at]
            if (op !== undefined) {
              if (replay) {
                const result = results[at]!
                const path =
                  result.status !== 'rejected' ? result.path : op.op === 'create' ? op.path : ''
                if (!(await receiptStillCurrent(this.fs, tx, { op, result, path }))) {
                  await countSuperseded(at, tx)
                  recorded++
                  continue
                }
              }
              const previous =
                this.opts.onApplied === undefined || op.op === 'create'
                  ? null
                  : await tx.byFileId(op.file_id)
              const keptBefore = this.report.kept.length
              try {
                if (verdicts.failures?.has(at)) throw verdicts.failures.get(at)
                await savepoint(tx, (sub) =>
                  recorder.withState(sub).take(op, results[at], at, verdicts)
                )
              } catch (error) {
                checkCancellation(this.opts.signal)
                await this.retainReceipt(op, results[at]!, error, tx)
                recorded++
                continue
              }
              recorded++
              const result = results[at]!
              if (
                this.opts.onApplied !== undefined &&
                result.status !== 'rejected' &&
                !verdicts.bad.has(at) &&
                !verdicts.staged.has(at) &&
                !verdicts.stale.has(at) &&
                !touchesDeferred(
                  this.opts.defer,
                  result.path,
                  previous?.wirePath,
                  result.status === 'conflict' ? result.conflict_path : null
                ) &&
                !verdicts.aside.has(at) &&
                this.report.kept.length === keptBefore
              ) {
                applied.push({
                  path: result.path,
                  kind:
                    op.op === 'delete' && result.status === 'applied'
                      ? 'delete'
                      : op.op === 'move'
                        ? 'move'
                        : 'upsert',
                  ...(op.op === 'move' && previous !== null ? { from: previous.wirePath } : {}),
                  origin: 'local',
                  fileId: result.file_id,
                })
              }
            }
          }
        }
        await this.opts.onCommitted?.(sending, tx)
        await tx.setJournal(null)
      })
      for (const change of applied) await notifyApplied(this.opts, change)
      if (interrupted) checkCancellation(this.opts.signal)
    } finally {
      await this.planner.discardStages(verdicts)
    }
  }

  /**
   * A file whose bytes are what they were but whose mtime is not: the scan had to hash it
   * to find that out, and writing the new mtime down is what saves the next scan from doing
   * the same. Paths this batch has ops for are left alone — their results settle them.
   *
   * The mtime written down is the one the scan hashed under, never a fresh `stat`: a file
   * edited since the scan would otherwise have its new size and mtime filed under the old
   * sha, and no scan would ever hash it again.
   */
  async refresh(scan: ScanResult): Promise<void> {
    for (const [wirePath, sha] of scan.hashes) {
      if (scan.dirty.has(wirePath)) continue
      const path = scan.diskPaths.get(wirePath) ?? wirePath
      const entry = await this.state.get(path)
      if (entry === null || entry.sha !== sha) continue
      const read = scan.infos.get(wirePath)
      if (read === undefined || (read.size === entry.size && read.mtime === entry.mtime)) continue
      await this.state.put({ ...entry, size: read.size, mtime: read.mtime })
    }
  }

  /* ── Uploads ─────────────────────────────────────────────────────────── */

  /**
   * Every distinct sha the batch names that the vault cannot already fetch.
   *
   * A 404 from `hasBlob` says only that no version of this vault names the sha: the bytes
   * may well be in the store already, from another vault or from an upload no commit
   * followed, and the PUT is 201 and cheap either way.
   */
  private async upload(ops: CommitOp[], sources: Sources): Promise<void> {
    const wanted: string[] = []
    const users = new Map<string, number>()
    for (const op of ops) {
      if (!('sha' in op)) continue
      const count = users.get(op.sha)
      users.set(op.sha, (count ?? 0) + 1)
      if (count === undefined) wanted.push(op.sha)
    }
    await pool(wanted, this.concurrency, async (sha) => {
      try {
        await this.uploadOne(sha, sources)
      } catch (error) {
        checkCancellation(this.opts.signal)
        if (!this.opts.retries || !isFileFailure(error)) throw error
        for (const op of ops)
          if ('sha' in op && op.sha === sha) {
            const path =
              op.op === 'create' ? op.path : (await this.state.byFileId(op.file_id))?.wirePath
            if (path === undefined) throw error
            await this.opts.retries.failed(path, 'push', error)
            this.report.kept.push(path)
          }
        this.waiting.set(sha, {
          code: 'conflict',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      this.fall(users.get(sha) ?? 0)
    })
  }

  /** One blob onto the server, unless it is there already or refused for good. */
  private async uploadOne(sha: string, sources: Sources): Promise<void> {
    checkCancellation(this.opts.signal)
    if (!this.client.checksBlobBeforeUpload && (await this.client.hasBlob(sha))) return
    try {
      const upload = async () => {
        checkCancellation(this.opts.signal)
        if (sources.open && this.client.putBlobSource) {
          const source = await sources.open(sha)
          if (!source) {
            this.opts.log?.(`push: no file on this disk holds ${sha}`)
            return
          }
          await this.client.putBlobSource(
            { sha, size: source.size },
            source,
            this.opts.signal,
            this.transferBudget.maxChunkBytes
          )
        } else {
          const bytes = await sources.bytes(sha)
          if (bytes === null) {
            this.opts.log?.(`push: no file on this disk holds ${sha}`)
            return
          }
          checkCancellation(this.opts.signal)
          await this.client.putBlob(sha, bytes, this.opts.signal)
        }
      }
      await this.transferBudget.run(upload, this.opts.signal)
    } catch (error) {
      if (!(error instanceof AbeleError)) throw error
      // The server will not have these bytes at any price: over its cap, or over the
      // vault's quota. Remembered, so the next push does not ask; the op is reported
      // refused and left out of the commit.
      // An upload refused because it exceeds the entire quota cannot fit until the
      // policy changes. A commit refused because OTHER live files occupy the quota
      // is different: pushRecord must not cache that result.
      if (FINAL_REFUSALS.has(error.code) || error.code === 'quota_exceeded') {
        this.recorder.refuse(sha, error)
        return
      }
      // Other devices' uploads fill the quota for now: this push goes on without the file, and
      // the next one asks again rather than taking the answer as final.
      if (error.code === 'quota_waiting') {
        this.waiting.set(sha, { code: error.code, message: error.message, details: error.details })
        return
      }
      // The file changed between the scan and the upload, so those bytes are not that
      // sha. Nothing is thrown: the commit refuses the op with `not_found`, the report
      // says so, and the journal clears — which is what unsticks a batch written against
      // bytes that have since gone.
      if (error.code !== 'hash_mismatch') throw error
      await sources.invalidate?.(sha)
      this.opts.log?.(`push: ${sha} is no longer what this disk holds`)
    }
  }
}
