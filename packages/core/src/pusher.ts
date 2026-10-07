import {
  AbeleError,
  type CommitOp,
  type CommitResponse,
  type ErrorCode,
  type JoinPrefer,
} from '@abele/sync-protocol'
import { pool } from './apply.js'
import type { CommitOutcome, VaultClient } from './client.js'
import type { ExpectedWrites } from './echo.js'
import { EngineError } from './errors.js'
import type { FileSystem } from './fs.js'
import { sha256 } from './hash.js'
import type { ScanFilter, ScanResult } from './scanner.js'
import type { Staged } from './defer.js'
import { batches, preferring } from './pushBatches.js'
import { PushDisk } from './pushDisk.js'
import { FINAL_REFUSALS, VerdictRecorder } from './pushRecord.js'
import { sourcesFromOps, sourcesFromScan, type Sources } from './pushSources.js'
import { VerdictPlanner } from './pushVerdicts.js'
import type { StateStore, Journal } from './state.js'
import {
  heldOwnerUnits,
  dropOwnerHold,
  settleOwnerUnit,
  type OwnerPushHooks,
} from './ownerHooks.js'

import { prepareOwnerJournal } from './ownerPrepare.js'
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

/** An op the server would not take, and what it said about it. */
export interface RejectedOp {
  op: CommitOp
  code: ErrorCode
  message: string
}

/** What the server said when it refused some bytes for good: over the cap, or over the quota. */
export interface Refusal {
  code: ErrorCode
  message: string
}

/**
 * The refusals a whole batch is turned away with that will be the same next time: any 4xx
 * bar the ones that mean "not now" (`rate_limited`) or "not you" (`unauthorized`, `forbidden`,
 * which the engine halts on). A batch refused so is not journalled: replaying it would only
 * be refused again, before every pull, for ever.
 */
const isFinalForBatch = (error: AbeleError): boolean =>
  error.status >= 400 &&
  error.status < 500 &&
  error.code !== 'rate_limited' &&
  error.code !== 'unauthorized' &&
  error.code !== 'forbidden'

export interface PushReport {
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
export interface ResumeOptions extends OwnerPushHooks {
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
   */
  onCommitted?: (ops: readonly CommitOp[]) => void | Promise<void>
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
  client: VaultClient,
  fs: FileSystem,
  state: StateStore,
  scan: ScanResult,
  opts: PushOptions
): Promise<PushReport> {
  const report = (await resumeJournal(client, fs, state, opts)) ?? emptyReport()
  const pusher = new Pusher(client, fs, state, opts, report, scan.diskPaths)
  await pusher.refresh(scan)
  const newKey = opts.keys ?? (() => crypto.randomUUID())
  const sources = sourcesFromScan(fs, scan)
  const held = await heldOwnerUnits(state, !!opts.beforeUpload)
  const heldCreates = new Set(
      held.flatMap((unit) => unit.ops.flatMap((op) => (op.op === 'create' ? [op.path] : [])))
    ),
    heldFiles = new Set(
      held.flatMap((unit) => unit.ops.flatMap((op) => ('file_id' in op ? [op.file_id] : [])))
    )
  const fresh = scan.ops.filter((op) =>
    op.op === 'create' ? !heldCreates.has(op.path) : !heldFiles.has(op.file_id)
  )
  const all = batches(pusher.sendable(preferring(fresh, opts.prefer)))
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
  client: VaultClient,
  fs: FileSystem,
  state: StateStore,
  opts: ResumeOptions
): Promise<PushReport | null> {
  const journal = await state.getJournal(),
    held = await heldOwnerUnits(state, !!opts.beforeUpload)
  const units = [
    ...(journal ? [journal] : []),
    ...held.filter((unit) => unit.idempotencyKey !== journal?.idempotencyKey),
  ]
  if (units.length === 0) return null
  // Older servers discarded receipts after a day. They cannot distinguish a
  // never-applied join from an applied one whose answer was lost. Do not repeat
  // a destructive user choice after that window, even against an upgraded server
  // whose old receipt may already be gone. Keep the journal for explicit recovery.
  const report = emptyReport(),
    pusher = new Pusher(client, fs, state, opts, report, new Map())
  for (const journal of units) {
    if (opts.beforeUpload || opts.onSettled) {
      const binding = await client.ownerPublicationIdentity()
      if (!journal.ownerBinding || JSON.stringify(journal.ownerBinding) !== JSON.stringify(binding))
        throw new EngineError('lost', 'owner journal binding requires reviewed recovery')
    }
    const age = Date.now() - Date.parse(journal.startedAt)
    if (
      (!Number.isFinite(age) || age >= 24 * 60 * 60 * 1000) &&
      journal.ops.some((op) => op.op === 'create' && op.prefer === 'mine')
    ) {
      throw new EngineError(
        'conflict',
        'an old local-preferred join needs recovery: preserve the local files and journal, then reconcile with current server history before starting a new join'
      )
    }
    opts.log?.(`push: replaying ${journal.ops.length} ops under ${journal.idempotencyKey}`)

    await pusher.batch(
      journal.ops,
      journal.idempotencyKey,
      journal.publicationPhase === 'submitted'
        ? { bytes: async () => null }
        : await sourcesFromOps(fs, state, journal.ops),
      journal.batchId,
      journal.startedAt,
      journal.operationIndices,
      journal.ownerBinding,
      journal.publicationPhase
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

/** One run of the pusher: the adapters, the options and the report it is filling in. */
class Pusher {
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
    private readonly client: VaultClient,
    fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: ResumeOptions,
    private readonly report: PushReport,
    /** wirePath → the on-disk spelling, as the scan found it; empty on a replay. */
    diskPaths: Map<string, string>
  ) {
    this.hash = opts.hash ?? sha256
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
    this.refused = opts.refused ?? new Map()
    const disk = new PushDisk(fs, state, opts, this.hash, diskPaths)
    this.planner = new VerdictPlanner(client, fs, state, opts, this.hash, this.concurrency, disk)
    this.recorder = new VerdictRecorder(fs, state, opts, report, this.hash, this.refused, disk)
  }

  /**
   * The ops worth sending: every one whose bytes the server has not already refused for
   * good. The rest are reported refused in the server's own words, without a request — the
   * file stays as it is, the engine keeps its path clear of the pulls, and the next scan
   * offers it again, to be turned away here again until its bytes or the cap change.
   */
  sendable(ops: CommitOp[]): CommitOp[] {
    const kept: CommitOp[] = []
    for (const op of ops) {
      const refusal = 'sha' in op ? this.refused.get(op.sha) : undefined
      const wait = 'sha' in op ? this.waiting.get(op.sha) : undefined
      if (refusal === undefined && wait === undefined) {
        kept.push(op)
        continue
      }
      const said = refusal ?? wait
      if (said === undefined) continue
      this.report.rejected.push({ op, ...said })
      this.opts.log?.(
        `push: ${op.op} refused: ${said.code} ${said.message} ` +
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
    operationIndices?: number[],
    ownerBinding?: Journal['ownerBinding'],
    publicationPhase?: Journal['publicationPhase']
  ): Promise<void> {
    // Refused or recorded, a batch's ops are through once it has returned.
    const after = this.left - ops.length
    await this.sendBatch(
      ops,
      key,
      sources,
      batchId,
      startedAt,
      operationIndices,
      ownerBinding,
      publicationPhase
    )
    this.fall(this.left - after)
  }

  private async sendBatch(
    ops: CommitOp[],
    key: string,
    sources: Sources,
    batchId?: string,
    startedAt?: string,
    operationIndices?: number[],
    ownerBinding?: Journal['ownerBinding'],
    publicationPhase?: Journal['publicationPhase']
  ): Promise<void> {
    if (this.opts.beforeUpload || this.opts.onSettled)
      ownerBinding ??= await this.client.ownerPublicationIdentity()
    let journal: Journal = {
      batchId: batchId ?? crypto.randomUUID(),
      ops,
      idempotencyKey: key,
      startedAt: startedAt ?? new Date().toISOString(),
      ...(operationIndices ? { operationIndices } : {}),
      ...(ownerBinding
        ? { ownerBinding, publicationPhase: publicationPhase ?? ('prepared' as const) }
        : {}),
    }
    if (this.opts.beforeUpload || this.opts.onSettled) await heldOwnerUnits(this.state, true)
    await this.state.setJournal(journal)
    const prepared = await prepareOwnerJournal(this.state, journal, this.opts.beforeUpload)
    for (const op of prepared.held) {
      const path =
        op.op === 'create'
          ? op.path
          : op.op === 'move'
            ? op.to_path
            : (await this.state.byFileId(op.file_id))?.wirePath
      if (path) this.report.kept.push(path)
    }
    if (!prepared.journal) return
    journal = prepared.journal
    ops = journal.ops
    // Submitted transport is immutable. External refusal caches and mutable
    // local upload state may affect new work, never a receipt replay body.
    const submitted = journal.publicationPhase === 'submitted'
    if (!submitted) await this.upload(ops, sources)
    const sending = submitted ? ops : this.sendable(ops)
    if (sending.length === 0) {
      await this.state.setJournal(null)
      return
    }
    if (journal.ownerBinding) {
      journal = {
        ...journal,
        ops: sending,
        operationIndices: sending.map(
          (op) => journal.operationIndices?.[ops.indexOf(op)] ?? ops.indexOf(op)
        ),
        publicationPhase: 'submitted',
      }
      await this.state.setJournal(journal)
    } else if (sending.length !== ops.length)
      await this.state.setJournal({ ...journal, ops: sending })

    let outcome: CommitOutcome
    try {
      outcome = await this.client.commitRaw(sending, key)
    } catch (error) {
      if (journal.publicationPhase === 'submitted') throw error
      if (!(error instanceof AbeleError) || !isFinalForBatch(error)) throw error
      this.opts.log?.(
        `push: the server refused the batch of ${sending.length}: ${error.code} ${error.message}`
      )
      for (const op of sending) {
        this.report.rejected.push({ op, code: error.code, message: error.message })
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
    const hookIndices = sending.map((op, index) =>
      journal.ownerBinding ? (journal.operationIndices?.[index] ?? index) : ops.indexOf(op)
    )
    const verdicts = await this.planner.plan(sending, results)
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
    await this.state.transaction(async () => {
      for (const [k, run] of verdicts.runs.entries()) {
        if (k > 0) await this.planner.fetchRun(run, verdicts)
        for (const at of run) {
          const op = sending[at]
          if (op !== undefined) await this.recorder.take(op, results[at], at, verdicts)
        }
      }
      if (this.opts.onSettled)
        await settleOwnerUnit(
          this.client,
          journal,
          sending,
          results,
          this.opts.onSettled,
          hookIndices,
          outcome.body.creation_outcomes
        )
      await this.opts.onCommitted?.(sending)
      if (this.opts.beforeUpload) await dropOwnerHold(this.state, key)
      await this.state.setJournal(null)
    })
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
      await this.uploadOne(sha, sources)
      this.fall(users.get(sha) ?? 0)
    })
  }

  /** One blob onto the server, unless it is there already or refused for good. */
  private async uploadOne(sha: string, sources: Sources): Promise<void> {
    if (await this.client.hasBlob(sha)) return
    const bytes = await sources.bytes(sha)
    if (bytes === null) {
      this.opts.log?.(`push: no file on this disk holds ${sha}`)
      return
    }
    try {
      await this.client.putBlob(sha, bytes)
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
        this.waiting.set(sha, { code: error.code, message: error.message })
        this.opts.log?.(`push: ${sha} waits for room: ${error.message}`)
        return
      }
      // The file changed between the scan and the upload, so those bytes are not that
      // sha. Nothing is thrown: the commit refuses the op with `not_found`, the report
      // says so, and the journal clears — which is what unsticks a batch written against
      // bytes that have since gone.
      if (error.code !== 'hash_mismatch') throw error
      this.opts.log?.(`push: ${sha} is no longer what this disk holds`)
    }
  }
}
