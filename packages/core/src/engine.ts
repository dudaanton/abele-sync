import type { ChangeItem } from '@abele/sync-protocol'
import { SyncCycle } from './cycle.js'
import type { DeleteDecision, HeldDelete } from './deletes.js'
import { ExpectedWrites } from './echo.js'
import {
  classifyFailure,
  messageOf,
  noop,
  type EngineOptions,
  type EngineStatus,
  type SyncReport,
} from './engineTypes.js'
import { guarded, stoppableClient } from './guard.js'
import type { DeferredApplied, DeferredKept, Staging } from './staging.js'
import { Wake } from './wake.js'
import { WatchReports } from './watchReports.js'

export { classifyFailure, joinFinished } from './engineTypes.js'
export type {
  EngineOptions,
  EngineState,
  EngineStatus,
  SyncFailure,
  SyncReport,
} from './engineTypes.js'

/**
 * The engine: the scanner, the puller and the pusher run as one sync, and that sync run
 * whenever something says it should — the server's event stream, the host's file watcher,
 * and a clock for when neither has spoken in a while.
 *
 * One sync is pull, scan, push, pull. The first pull brings the server's changes down before
 * the disk is read, so the scan describes a disk that already agrees with the state about
 * everything this device did not touch; the last pull brings back what the server made of
 * the push — merged text, conflict copies, and the changes the first pull held because a
 * local edit stood in their way. Nothing here decides who wins; the server does that, and the
 * engine only carries the answer to the right place in the right order.
 *
 * The host sees a `status` and a log line now and then. Everything the host has to remember
 * lives in the `StateStore`; the engine's own memory is what one process needs between two
 * runs, and a fresh process starts with none of it and is still correct — only more careful.
 */

const DEFAULT_DEBOUNCE_MS = 300
const DEFAULT_BACKOFF_MS: readonly [number, number] = [2_000, 60_000]
const DEFAULT_FALLBACK_MS = 5 * 60 * 1_000

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

export class SyncEngine {
  private readonly expected = new ExpectedWrites()
  private readonly log: (line: string) => void
  private readonly now: () => number

  private current: EngineStatus = {
    state: 'idle',
    pending: 0,
    lastSyncAt: null,
    lastError: null,
    cursor: 0,
    headSeq: null,
    heldDeletes: 0,
    deferred: 0,
  }
  private readonly listeners = new Set<(status: EngineStatus) => void>()

  /**
   * The sync in progress — or the host's job on the staged changes, which runs in its place —
   * and the sync promised to everybody who asked while it ran.
   */
  private running: Promise<unknown> | null = null
  private queued: Deferred<SyncReport> | null = null

  private started = false
  private paused = false
  /** Set by a refused token: nothing runs on its own until `resume()`. */
  private halted = false
  private unwatch: (() => void) | null = null
  /** The highest seq a frame carried while a sync was running, or null when none did. */
  private heard: number | null = null

  /** The watcher's reports; see `watchReports.ts`. */
  private readonly watch: WatchReports
  /** The event stream and the timers; see `wake.ts`. */
  private readonly wake: Wake
  /** One sync and what it remembers between runs; see `cycle.ts`. */
  private readonly cycle: SyncCycle
  /** The cycle's staged changes, as the engine hands them to the host; see `staging.ts`. */
  private readonly staging: Staging

  private readonly opts: EngineOptions
  private cancellation = new AbortController()
  private stopping = false
  private readonly activeWrites = { count: 0 }

  constructor(opts: EngineOptions) {
    const hands =
      opts.stillHeld === undefined && opts.recovery === undefined
        ? opts
        : guarded(opts, () => {
            opts.recovery?.assertReady()
            return opts.stillHeld?.() ?? true
          })
    this.opts = {
      ...hands,
      client: stoppableClient(hands.client, () => this.cancellation.signal, this.activeWrites),
    }
    this.log = opts.log ?? noop
    this.now = opts.now ?? (() => Date.now())
    this.watch = new WatchReports({
      fs: this.opts.fs,
      expected: this.expected,
      debounceMs: opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      onChange: () => this.trigger('watch'),
    })
    this.wake = new Wake({
      client: this.opts.client,
      log: this.log,
      backoffMs: opts.backoffMs ?? DEFAULT_BACKOFF_MS,
      fallbackMs: opts.fallbackMs ?? DEFAULT_FALLBACK_MS,
      live: () => this.started && !this.paused && !this.halted,
      trigger: (why) => this.trigger(why),
      onSeq: (seq) => this.onSeq(seq),
    })
    this.cycle = new SyncCycle({
      opts: this.opts,
      expected: this.expected,
      watch: this.watch,
      log: this.log,
      now: this.now,
      set: (patch) => this.set(patch),
      status: () => this.current,
      watching: () => this.unwatch !== null,
      stopping: () => this.stopping,
    })
    this.staging = this.cycle.staging
    // Built on a scope is where the scope is recorded: a host rebuilds the engine on a change,
    // paused or not, and may run nothing on it before the next change.
    if (opts.recovery === undefined) void this.recordScope().catch(noop)
    // Staged by an earlier process: the status says so before the first sync does.
    if (opts.recovery === undefined)
      void this.countStaged().catch((error: unknown) =>
        this.log(`sync: staged changes not read: ${messageOf(error)}`)
      )
    // Held by an earlier process: likewise, since a paused or offline one may not reach the check.
    if (opts.recovery === undefined)
      void this.cycle
        .countHeld()
        .catch((error: unknown) => this.log(`sync: held deletes not read: ${messageOf(error)}`))
  }

  /**
   * Mark the synced files this scope leaves out, asking the server nothing. Taken when the
   * engine is built, when it starts and at the start of every run; a host may call it too, and
   * a run waits for the last one to finish. A failure is logged, and the next run marks again.
   */
  async recordScope(): Promise<void> {
    this.opts.recovery?.assertReady()
    return this.cycle.recordScope()
  }

  /* ── Status ──────────────────────────────────────────────────────────── */

  get status(): EngineStatus {
    return { ...this.current }
  }

  /** Called with a copy of the status whenever any of it changes. */
  onStatus(cb: (status: EngineStatus) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private set(patch: Partial<EngineStatus>): void {
    const next = { ...this.current, ...patch }
    const changed = (Object.keys(next) as Array<keyof EngineStatus>).some(
      (key) => next[key] !== this.current[key]
    )
    if (!changed) return
    this.current = next
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...next })
      } catch (error) {
        this.log(`status listener failed: ${messageOf(error)}`)
      }
    }
  }

  /* ── One sync ────────────────────────────────────────────────────────── */

  /**
   * Run one sync, or join the one that is running.
   *
   * A call while a sync is under way does not start a second one beside it: it is promised
   * the run that follows, which starts once the current one is over and takes in whatever
   * prompted the call. However many ask while one runs, one more run follows.
   */
  sync(): Promise<SyncReport> {
    try {
      this.opts.recovery?.assertReady()
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.running !== null) {
      this.queued ??= deferred<SyncReport>()
      return this.queued.promise
    }
    return this.launch()
  }

  /**
   * Walk the manifest again, then sync as usual: for a host that has just widened selective
   * sync, so what the pulls passed over is fetched. The cursor goes back to 0 at the start of
   * the run rather than here, so a pull under way is not writing its own position over it.
   * Everything the device already has is known by its version and passed over.
   */
  rescan(): Promise<SyncReport> {
    try {
      this.opts.recovery?.assertReady()
    } catch (error) {
      return Promise.reject(error)
    }
    this.cycle.rewind = true
    return this.sync()
  }

  /** The deletes the guard is holding, as last filed: the wire path and the file id of each. */
  heldDeletes(): Promise<HeldDelete[]> {
    return this.cycle.holds.list()
  }

  /**
   * Decide about the held deletes the person was shown, named by `fileIds`: `confirm` sends
   * them, `restore` brings the files back from the server. Only those are decided — an id no
   * longer held is passed over, and a delete held since the list was read stays held. The decision is filed for the next run, which starts now unless the engine
   * is paused or its token refused; then it is taken once syncing resumes. Answers how many
   * were decided — 0 when none of them is held any more — and the run's report, or null when
   * nothing was decided or the decision waits for syncing to resume.
   */
  async decideDeletes(
    kind: DeleteDecision['kind'],
    fileIds: readonly string[]
  ): Promise<{ decided: number; report: SyncReport | null }> {
    this.opts.recovery?.assertReady()
    const shown = new Set(fileIds)
    const holds = this.cycle.holds
    const decided = (await holds.list()).map((one) => one.fileId).filter((id) => shown.has(id))
    if (decided.length === 0) return { decided: 0, report: null }
    await holds.decide({ kind, fileIds: decided, at: new Date(this.now()).toISOString() })
    if (this.paused || this.halted) return { decided: decided.length, report: null }
    return { decided: decided.length, report: await this.sync() }
  }

  /** Authorized server Restore, serialized and recovery-gated like deferred writes. */
  restore(fileId: string, versionId: string, requestId?: string) {
    return this.exclusive(() => this.opts.client.restore(fileId, versionId, requestId))
  }
  restoreDeleted(fileId: string, requestId?: string) {
    return this.exclusive(() => this.opts.client.restoreDeleted(fileId, requestId))
  }

  /* ── Staged changes ──────────────────────────────────────────────────── */

  /** The changes staged for the host (`EngineOptions.defer`), oldest first, as the server gave them. */
  deferred(): Promise<ChangeItem[]> {
    return this.staging.list()
  }

  /**
   * Write the staged changes, in the sync queue: after the sync that is running, and before any
   * asked for meanwhile. A path whose file changed here since its change was staged is skipped
   * and keeps its record: that is this device's edit, which the next scan sends, and the record
   * goes once that commit lands. The host reloads what reads these files afterwards.
   *
   * `versionIds` are the versions the host showed the person. With them only the records whose
   * current version is one of these are written: a record never shown, or replaced by a later
   * change since — a sync that ran before this one staged it — stays staged, unwritten, and comes
   * back in `unshown`, so the host asks about it rather than reload into it. Without them every
   * staged change is written and there is no `unshown`. Code approval callers must pass the
   * exact versions shown, as the plugin dialog and daemon code command do.
   */
  applyDeferred(versionIds?: readonly string[]): Promise<DeferredApplied> {
    return this.exclusive(async () => {
      await this.watch.examine()
      const dirty = new Set([
        ...this.cycle.kept,
        ...this.watch.reported,
        ...this.cycle.unsettled,
        ...(await this.cycle.holds.held()),
      ])
      const shown = versionIds === undefined ? null : new Set(versionIds)
      const result = await this.staging.apply(dirty, shown)
      await this.countStaged()
      return result
    })
  }

  /**
   * Keep this device's files over the staged changes — all of them, or those at `paths` (a
   * staged move is named by either end). Each file this disk has keeps its bytes while its entry
   * moves to the server's version, so the next scan sends this disk as it is, as a change on the
   * head: an edit, or a file the server deleted created again. Rejecting a remote move keeps
   * the old local path as a separate file to upload, without deleting the remote target. A file only the other side has — a plugin installed there, say — is left
   * there and stays absent here: its staged change is dropped and nothing is sent, so keeping
   * never deletes a file on another device. The next sync is started when the engine runs on its
   * own and something was kept; answers the paths kept and the paths left.
   *
   * `versionIds` are the versions the host showed the person. With them only the records whose
   * current version is one of these are kept: one replaced since it was shown, or never shown,
   * is left staged and comes back in `unshown` (of those `paths` names), so this device's bytes
   * never go out over a change nobody saw. Without them there is no `unshown`.
   */
  async keepLocal(paths?: string[], versionIds?: readonly string[]): Promise<DeferredKept> {
    const result = await this.exclusive(async () => {
      const done = await this.staging.keep(
        paths === undefined ? null : new Set(paths),
        versionIds === undefined ? null : new Set(versionIds)
      )
      await this.countStaged()
      return done
    })
    if (result.kept.length > 0) this.trigger('keep local')
    return result
  }

  /** The staged count, onto the status. */
  private countStaged(): Promise<number> {
    return this.cycle.countStaged()
  }

  private launch(): Promise<SyncReport> {
    this.stopping = false
    if (this.cancellation.signal.aborted) this.cancellation = new AbortController()
    return this.occupy(this.run())
  }

  /**
   * Make `work` the engine's one job. Once it is over, the sync promised to whoever asked
   * meanwhile starts.
   */
  private occupy<T>(work: Promise<T>): Promise<T> {
    this.running = work
    void work.then(noop, noop).then(() => {
      this.running = null
      const next = this.queued
      if (next === null) return
      this.queued = null
      this.launch().then(next.resolve, next.reject)
    })
    return work
  }

  /** A host's job on the engine's state, run in the sync queue rather than beside a sync. */
  private async exclusive<T>(job: () => Promise<T>): Promise<T> {
    this.opts.recovery?.assertReady()
    while (this.running !== null) await this.running.then(noop, noop)
    this.opts.recovery?.assertReady()
    return this.occupy(job())
  }

  private async run(): Promise<SyncReport> {
    this.heard = null
    this.set({ state: 'syncing' })
    try {
      this.opts.recovery?.assertReady()
      const report = await this.cycle.cycle()
      this.wake.succeeded()
      this.set({
        state: this.paused ? 'paused' : 'idle',
        lastSyncAt: new Date(this.now()).toISOString(),
        lastError: null,
      })
      this.tell(() => this.opts.onSync?.(report))
      // A commit another device made while this ran is one this run may not have reached.
      if (this.heard !== null && this.heard > this.current.cursor) this.trigger('events')
      return report
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** A host's hook, run where a throw of its own cannot be mistaken for the sync's. */
  private tell(hook: () => void): void {
    try {
      hook()
    } catch (error) {
      this.log(`hook failed: ${messageOf(error)}`)
    }
  }

  private fail(error: unknown): void {
    const message = messageOf(error)
    this.log(`sync failed: ${message}`)
    const kind = classifyFailure(error)
    this.tell(() => this.opts.onFail?.(error, kind))
    switch (kind) {
      case 'offline':
        this.set({ state: 'offline', lastError: message })
        this.wake.retryLater()
        return
      case 'unauthorized':
        // Asking again with the same token gets the same answer. The host re-enrols, then resumes.
        this.halted = true
        this.wake.disconnect()
        this.wake.clearTimers()
        this.set({ state: 'error', lastError: message })
        return
      default:
        this.set({ state: 'error', lastError: message })
    }
  }

  /* ── Triggers ────────────────────────────────────────────────────────── */

  /**
   * Run on the server's events, on the watcher's reports, on a clock, and once now.
   */
  start(): void {
    this.opts.recovery?.assertReady()
    if (this.started) return
    this.stopping = false
    // Subscribe before launching the first sync, so renew a stopped connection here too.
    if (this.cancellation.signal.aborted) this.cancellation = new AbortController()
    this.started = true
    void this.recordScope().catch(noop)
    // Whatever was edited while nothing was watching is nobody's report but the disk's.
    this.cycle.unscanned = true
    this.unwatch = this.opts.fs.watch?.((paths) => this.watch.notice(paths)) ?? null
    this.wake.connect()
    this.wake.scheduleFallback()
    this.trigger('start')
  }

  /** Hang up, stop watching, cancel every timer, and wait for the sync that is running. */
  async stop(): Promise<void> {
    this.stopping = true
    this.started = false
    this.unwatch?.()
    this.unwatch = null
    this.wake.disconnect()
    this.wake.clearTimers()
    this.watch.cancel()
    // A sent commit may already have landed; wait for its answer and ledger recording.
    // A blocked read has no such side effect and can be abandoned immediately.
    if (this.activeWrites.count === 0) this.cancellation.abort()
    // A run promised to callers while this one ran still follows it; wait for that too.
    while (this.running !== null) await this.running.then(noop, noop)
  }

  /** Stop syncing on any trigger. A running sync finishes; `sync()` still runs when asked. */
  pause(): void {
    if (this.paused) return
    this.paused = true
    this.wake.disconnect()
    this.wake.clearTimers()
    if (this.running === null) this.set({ state: 'paused' })
  }

  /** Forget the pause and any refused token, take the triggers back, and sync now. */
  resume(): void {
    this.opts.recovery?.assertReady()
    this.paused = false
    this.halted = false
    this.set({ state: this.running === null ? 'idle' : 'syncing', lastError: null })
    if (this.started) {
      this.wake.connect()
      this.wake.scheduleFallback()
    }
    void this.sync().catch(noop)
  }

  private trigger(why: string): void {
    if (!this.started || this.paused || this.halted) return
    this.log(`sync: ${why}`)
    void this.sync().catch(noop)
  }

  /**
   * A seq the vault has reached. While a sync runs it is only noted — that run may well
   * reach it, and the check at its end says whether it did — and otherwise anything past
   * what this device has seen is a reason to run.
   */
  private onSeq(seq: number): void {
    this.set({ headSeq: Math.max(seq, this.current.headSeq ?? 0) })
    if (this.running !== null) {
      this.heard = Math.max(seq, this.heard ?? 0)
      return
    }
    if (seq > this.current.cursor) this.trigger('events')
  }
}
