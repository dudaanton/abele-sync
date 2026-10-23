import type { StateStore } from './state.js'
import { transact } from './stateTransaction.js'
import type { CommitOp } from '@abele/sync-protocol'
import { fetchChecked } from './apply.js'
import { DeleteGate } from './deleteGate.js'
import { DeleteHolds } from './deletes.js'
import type { Staged } from './defer.js'
import type { ExpectedWrites } from './echo.js'
import {
  fold,
  foldPush,
  messageOf,
  type EngineOptions,
  type EngineStatus,
  type SyncReport,
} from './engineTypes.js'
import { EngineError } from './errors.js'
import { sha256 } from './hash.js'
import { pull, type PullReport } from './puller.js'
import { push, resumeJournal, resumeReceipts, type PushReport, type Refusal } from './pusher.js'
import { scan, type CaseCollision, type ScanFilter } from './scanner.js'
import { AsideMarks, ScopeMarks, type ScopeRecord } from './scope.js'
import { isExcluded } from './selective.js'
import { Staging } from './staging.js'
import type { StateEntry } from './state.js'
import type { WatchReports } from './watchReports.js'
import { refreshLocalPaths } from './localPaths.js'
import { stoppableListings } from './guard.js'
import { resumesScopeRecheck } from './pullRun.js'
import { importLegacyPullHolds } from './pullHolds.js'
import { scanSnapshot } from './scanSnapshot.js'
import { readReconciliation } from './reconciliation.js'
import { recoverPendingPullWrites } from './pullRecovery.js'
import { recoverPullEvictions } from './pullEvictions.js'
import { FileRetries, retryAttempt } from './fileRetry.js'
import { GENERATION_KEY, MEMBERS_KEY, RECONCILING_KEY } from './restoreGeneration.js'
import {
  reconciliationScan,
  preserveRestoredEdits,
  preserveGenerationConflicts,
  RECONCILIATION_KEY,
} from './reconciliation.js'

/**
 * One sync, and what the engine remembers from one to the next to run it: pull, scan, push,
 * pull (see `engine.ts`), the scope and the refusals it runs under, and the paths no pull may
 * write over. The engine decides when a sync runs; this is what one does.
 */

export const DEFAULT_SCRIPTS_FOLDER = 'Scripts'

/** The engine, as one sync needs it. */
export interface CycleContext {
  /** The options, through the guard when the host handed in `stillHeld`. */
  opts: EngineOptions
  expected: ExpectedWrites
  watch: WatchReports
  log: (line: string) => void
  now: () => number
  signal?: () => AbortSignal
  scanning?: (active: boolean) => void
  /** Change the status. */
  set: (patch: Partial<EngineStatus>) => void
  /** The status as it stands. */
  status: () => EngineStatus
  /** Whether the host's watcher is reporting. */
  watching: () => boolean
  /** Stop requested: settle the push already sent, but do not start another pull. */
  stopping: () => boolean
}

/**
 * The state's mark of a join in progress: set when a run starts joining, cleared once that
 * join's push is answered. While it is there the engine is joining, whatever the cursor says.
 */
const JOIN_KEY = 'join-open'

export class SyncCycle {
  readonly retries: FileRetries
  readonly filter: ScanFilter
  /**
   * The server's own cap. Pulls exclude larger files; clients opting into size
   * refusals still scan local files so the push reports their pending work.
   */
  private serverCap: number | null = null
  private readonly scanFilter: ScanFilter
  /** sha → the refusal the server gave it for good, until the cap or the quota change. */
  private readonly refused = new Map<string, Refusal>()
  /** The cap and the quota the refusals were given under; a change empties the map. */
  private refusedUnder: string | null = null

  /** Wire paths the last push kept on their old base: unpushed typing until the next scan. */
  kept = new Set<string>()
  /** The last scan's dirty paths, until a push has recorded them. */
  unsettled = new Set<string>()
  /** The wire paths the last scan held back as case collisions, so each is logged once. */
  private collided = new Set<string>()
  /** Until a scan has run in this process, the disk may hold edits nobody reported. */
  unscanned = true
  /** Set by `rescan`: the next run winds the cursor back to 0 before it pulls. */
  rewind = false
  retryRefusedDirectories = false
  /** Set once a run has started or ended with the cursor above 0: no preference is sent again. */
  private joined = false
  /** Only a batch this live engine just sent is known not to originate in a restored profile. */
  private liveJournalKey: string | undefined
  /** The synced files out of scope since this device last saw them in it; see `ScopeMarks`. */
  private readonly scope: ScopeMarks
  /** The marks this engine last asked for, which a run waits for before it reviews them. */
  private marked: Promise<void> = Promise.resolve()
  /** Server files passed over for a local file this device does not sync; see `AsideMarks`. */
  private readonly asides: AsideMarks
  /** The deletes the guard holds, and the decision a host filed about them; see `deletes.ts`. */
  readonly holds: DeleteHolds
  /** The changes staged for the host rather than written; see `defer.ts` and `staging.ts`. */
  readonly staging: Staging
  private readonly gate: DeleteGate
  /** How many times a run has set the held count, so a read of the filed hold never undoes one. */
  private heldSet = 0

  constructor(private readonly ctx: CycleContext) {
    const { opts } = ctx
    this.retries = new FileRetries(opts.state, ctx.now, ctx.log)
    const scriptsFolder = opts.scriptsFolder ?? DEFAULT_SCRIPTS_FOLDER
    const localFilter: ScanFilter = {
      excluded: (path, size) =>
        (opts.client.includes !== undefined && !opts.client.includes(path)) ||
        isExcluded(path, size, opts.selective, scriptsFolder) ||
        (opts.ignore?.ignores(path) ?? false),
    }
    this.filter = {
      excluded: (path, size) =>
        (this.serverCap !== null && size > this.serverCap) || localFilter.excluded(path, size),
    }
    this.scanFilter = opts.client.reportSizeRefusals ? localFilter : this.filter
    // Through the guard like every other state write.
    this.scope = new ScopeMarks(opts.state)
    this.asides = new AsideMarks(opts.state)
    this.holds = new DeleteHolds(opts.state)
    this.staging = new Staging({
      client: opts.client,
      fs: opts.fs,
      state: opts.state,
      filter: this.filter,
      expected: ctx.expected,
      onApplied: opts.onApplied,
      defer: opts.defer,
      log: (line) => ctx.log(line),
    })
    this.gate = new DeleteGate({
      state: opts.state,
      fs: opts.fs,
      filter: this.filter,
      holds: this.holds,
      deleteGuard: opts.deleteGuard,
      now: () => ctx.now(),
      log: (line) => ctx.log(line),
      onHeld: (count) => {
        this.heldSet++
        ctx.set({ heldDeletes: count })
      },
      rewind: () => {
        this.rewind = true
      },
    })
  }

  /** Mark the synced files this scope leaves out; see `SyncEngine.recordScope`. */
  recordScope(signal?: AbortSignal): Promise<void> {
    const { opts } = this.ctx
    const record: ScopeRecord = {
      selective: opts.selective,
      scriptsFolder: opts.scriptsFolder ?? DEFAULT_SCRIPTS_FOLDER,
      ...(opts.ignoreText === undefined ? {} : { ignore: opts.ignoreText }),
    }
    const marking = this.scope
      .record(
        stoppableListings(opts.fs, () => signal),
        structuredClone(record),
        this.filter
      )
      .catch((error: unknown) => {
        if (!(error instanceof EngineError && error.code === 'lost'))
          this.ctx.log(`scope: not recorded: ${messageOf(error)}`)
        throw error
      })
    this.marked = marking
    return marking
  }

  /**
   * The hold as filed, onto the status, asking the server nothing: an engine built over a hold
   * an earlier process filed says so before a run reaches the delete check, which a paused or
   * offline one may not do for a while. A count a run
   * set while the list was read is newer, and is left alone.
   */
  async countHeld(): Promise<void> {
    const seen = this.heldSet
    const held = await this.holds.list()
    if (this.heldSet === seen) this.ctx.set({ heldDeletes: held.length })
  }

  /** The staged count, onto the status. */
  async countStaged(): Promise<number> {
    const count = await this.staging.count()
    this.ctx.set({ deferred: count })
    return count
  }

  /**
   * Pull, scan, push, pull.
   *
   * The first pull is told which paths it must not write over: what the last push kept
   * because the file changed under it, what the watcher has reported since the last scan,
   * what the last scan found and no push has recorded yet — and, when no watcher could have
   * said, every synced file whose size or mtime no longer match its entry. The scan then
   * reads the disk; a held change to a path it found clean is applied straight away, before
   * the push, and the pull after the push brings back what the server made of it all.
   */
  async cycle(): Promise<SyncReport> {
    const { client, fs, state } = this.ctx.opts
    await this.retries.load()
    if (this.retryRefusedDirectories) this.rewind = true
    const inventory = scanSnapshot(fs, () => this.ctx.signal?.())
    const scanningFs = stoppableListings(inventory.fs, () => this.ctx.signal?.())
    const generationBefore = await state.getMeta?.(GENERATION_KEY)
    await client.prepare?.(
      fs,
      state,
      (path) =>
        this.ctx.opts.ignore?.ignores(path + '/') === true ||
        (this.ctx.opts.selective?.excludedFolders ?? []).some(
          (folder) =>
            path === folder.normalize('NFC') || path.startsWith(folder.normalize('NFC') + '/')
        ),
      this.ctx.signal?.(),
      true
    )
    if (generationBefore !== (await state.getMeta?.(GENERATION_KEY))) {
      await this.retries.load()
      this.staging.records.invalidate()
      this.refused.clear()
      this.kept.clear()
      this.unsettled.clear()
      this.unscanned = true
      this.ctx.log('sync: server generation observed; reconciling with local files preserved')
    }
    const log = this.ctx.log
    if (this.retries.list().some((row) => this.retries.ready(row.path)))
      await client.retryRefusedDirectories?.(
        this.retries
          .list()
          .filter((row) => this.retries.ready(row.path))
          .map((row) => row.path)
      )
    await fs.recoverConditionalFiles?.()
    await recoverPullEvictions(fs, state, this.ctx.signal?.(), this.retries)
    const pendingFiles = new Set(
      ((await state.metadataKeys?.('pull-write:')) ?? []).map((key) =>
        key.slice('pull-write:'.length)
      )
    )
    if (!state.metadataKeys) for await (const entry of state.all()) pendingFiles.add(entry.fileId)
    await recoverPendingPullWrites(fs, state, [...pendingFiles], client, {
      log,
      expected: this.ctx.expected,
      signal: this.ctx.signal?.(),
      retries: this.retries,
    })
    const common = {
      retries: this.retries,
      signal: this.ctx.signal?.(),
      ...(this.ctx.opts.transferBudget === undefined
        ? {}
        : { transferBudget: this.ctx.opts.transferBudget }),
      expected: this.ctx.expected,
      onApplied: this.ctx.opts.onApplied,
      refused: this.refused,
      maxFileBytes: undefined as number | undefined,
      filter: this.filter,
      // A push answered with the server's bytes for a staged path stages them, as a pull would
      ...(this.ctx.opts.defer === undefined
        ? {}
        : {
            defer: this.ctx.opts.defer,
            onDefer: (staged: Staged[]) => this.staging.stage(staged),
          }),
      log,
    }
    await resumeReceipts(client, fs, state, common)

    // Read before a rescan winds the cursor back: only a device that has not joined yet joins.
    // A join a process started and did not finish is marked in the state, so a restart after
    // its first pull moved the cursor still joins, with the side the person chose.
    const marked = await this.joinMarked()
    if ((await state.getCursor()) > 0 && !marked) this.joined = true
    const reconciling = (await state.getMeta?.(RECONCILING_KEY)) != null
    const joining = !this.joined && !reconciling
    const joinReview = await readReconciliation(state)
    const prefer =
      joining && (!joinReview || joinReview.phase === 'complete')
        ? this.ctx.opts.joinPrefer
        : undefined
    if (joining && !marked) await this.markJoin(true)
    if (prefer !== undefined) log(`sync: joining the vault; where both hold a file, ${prefer} wins`)

    // Before the server is asked anything, so a narrowing is recorded even offline. A file
    // that came back into scope is settled by a manifest walk, so a widening always walks it,
    // whether or not the host asked for the rescan.
    await importLegacyPullHolds(state, client)
    await this.recordScope(this.ctx.signal?.())
    const scope = await this.scope.review(scanningFs, this.filter)
    for (const path of scope.forgotten) {
      log(`scope: ${path} went while this device did not sync it; the vault's copy is kept`)
    }
    if (
      scope.forgotten.length > 0 ||
      (scope.recheck.size > 0 && !(await resumesScopeRecheck(state, scope.recheck)))
    )
      this.rewind = true
    if (await this.asides.due(scanningFs, this.filter)) {
      log('scope: a local file a server file was passed over for has gone; walking the vault')
      this.rewind = true
    }
    const vault = await client.state()
    this.ctx.set({ headSeq: vault.head_seq, cursor: await state.getCursor() })
    this.learnLimits(vault.settings.max_file_bytes, vault.settings.quota_bytes)
    common.maxFileBytes = vault.settings.max_file_bytes
    await this.retries.refreshServerPolicy(this.refusedUnder!, vault.head_seq)
    const comparisonCursor = await state.getCursor()
    let earlyPull: PullReport | null = null
    const priorReconciliation = await readReconciliation(state)
    if (
      !reconciling &&
      (!priorReconciliation || priorReconciliation.phase === 'complete') &&
      (await state.getJournal()) === null &&
      (await this.holds.decision()) === null
    ) {
      if (this.rewind) {
        await this.rewindPull()
      }
      const holding = await this.holds.held()
      await this.ctx.watch.examine()
      earlyPull = await this.pull(
        new Set([...this.kept, ...this.unsettled, ...holding, ...this.ctx.watch.reported]),
        scope.recheck,
        holding
      )
      this.ctx.set({ cursor: earlyPull.cursor })
      // Retire empty remote departures before directory publication can mistake
      // their old local spellings for newly created local directories.
      await client.finishPull?.()
    }
    await this.scanWork(() => refreshLocalPaths(scanningFs, state))
    if (reconciling || (priorReconciliation && priorReconciliation.phase !== 'complete'))
      await this.scanWork(
        () => client.scanLocal?.(scanningFs, this.ctx.signal?.()) ?? Promise.resolve()
      )
    const inspection = await this.scanWork(async () =>
      reconciliationScan(
        scanningFs,
        state,
        this.scanFilter,
        vault.head_seq,
        this.liveJournalKey,
        reconciling
          ? (JSON.parse((await state.getMeta?.(MEMBERS_KEY)) ?? '[]') as StateEntry[])
          : undefined,
        this.unscanned,
        client,
        this.ctx.signal?.(),
        comparisonCursor,
        this.retries
      )
    )
    const reconciliation = inspection.reconciliation
    if (!reconciling && reconciliation && reconciliation.phase !== 'complete')
      await preserveRestoredEdits(
        client,
        fs,
        inspection.basis,
        inspection.found,
        this.scanFilter,
        false,
        this.ctx.opts.defer
      )
    if (!reconciling && reconciliation && reconciliation.phase !== 'complete')
      inventory.invalidate()
    this.ctx.set({ reconciliation })

    // Read through the guarded state, and every step it leads to is a guarded write: a daemon
    // whose lock lapsed takes nothing of it (see `stillHeld`).
    const filed = await this.holds.decision()
    // What went out before a decision counts no more toward the guard.
    if (filed !== null) await this.holds.resetTally()
    const confirmed = new Set(filed?.decision.kind === 'confirm' ? filed.decision.fileIds : [])
    // Counted as each commit lands, so a push cut off half way still counts what it sent — and
    // so does a replay, whose batch may have landed before its answer was lost.
    const tally = (ops: readonly CommitOp[], tx: StateStore): Promise<void> =>
      this.gate.tallySent(ops, confirmed, tx)
    if (filed?.decision.kind === 'restore') await this.gate.putBack(filed.decision)

    if (this.rewind) {
      await this.rewindPull()
    }
    // Carried out once the feed is rewound: killed before that, the next run does it again.
    if (filed?.decision.kind === 'restore') await this.holds.settle(filed.raw)

    // A batch the last run never finished recording goes first: a scan taken over it would
    // describe a disk the state does not know about yet.
    const replayed = await resumeJournal(client, fs, state, { ...common, onCommitted: tally })
    if (replayed?.reconciliationRequired) return this.cycle()
    // Receipt settlement may replace bytes before the resumed pull. Inventory
    // and persisted-hint validation must use those installed source stamps.
    if (replayed !== null) inventory.invalidate()
    this.liveJournalKey = undefined
    for (const path of replayed?.kept ?? []) this.kept.add(path)
    if (!reconciliation || reconciliation.phase === 'complete') await client.syncDirectories?.()

    // The watcher's latest batch, without waiting for the debounce: what it holds is exactly
    // what the pull must not write over.
    const reported = this.ctx.watch.reported
    await this.ctx.watch.examine()
    const holding = await this.holds.held()
    const protect = new Set([...this.kept, ...reported, ...this.unsettled, ...holding])
    for await (const entry of state.all())
      if (inspection.found.dirty.has(entry.wirePath)) protect.add(entry.wirePath)
    const first = earlyPull ?? (await this.pull(protect, scope.recheck, holding))
    if (earlyPull === null && first.applied > 0) inventory.invalidate()
    if (reconciling)
      await preserveGenerationConflicts(
        client,
        fs,
        state,
        inspection.found,
        first.held,
        this.scanFilter
      )
    if (reconciling) inventory.invalidate()
    // Content inspection and conflict preservation are durable independently of upload.
    // A later network failure must not request another full content sweep on restart.
    if (reconciliation?.phase === 'requested') {
      reconciliation.phase = 'review'
      await state.setMeta?.(RECONCILIATION_KEY, JSON.stringify(reconciliation))
      this.ctx.set({ reconciliation })
    }
    this.ctx.set({ cursor: first.cursor })
    const releasedStaged = await this.staging.tidy(protect)
    if (releasedStaged) inventory.invalidate()
    // A walk that finished has confirmed every file back in scope, or taken it.
    if (first.bootstrapped) await this.scope.settle(scope.recheck)

    // Paths reported before the scan are taken in by it; anything reported while it reads
    // the tree may or may not be, and stays for the next run.
    const seen = [...reported]
    // A lost note's text is only on the server now; it is read back to tell an edited rename
    // from a delete and an unrelated create (`likeness.ts`).
    const previous = (entry: StateEntry): Promise<Uint8Array | null> =>
      fetchChecked(client, entry.sha, sha256)
    await this.scanWork(
      () => client.scanLocal?.(scanningFs, this.ctx.signal?.(), reported) ?? Promise.resolve()
    )
    const observed =
      !releasedStaged &&
      (earlyPull !== null || (first.applied === 0 && replayed === null && !reconciling))
        ? inspection.found
        : undefined
    const found = await this.scanWork(() =>
      scan(scanningFs, state, this.scanFilter, {
        retries: this.retries,
        signal: this.ctx.signal?.(),
        persistHints: true,
        known: observed,
        log,
        previous,
        verifyPaths: new Set([
          ...(observed === undefined ? inspection.found.dirty : []),
          ...reported,
        ]),
        pairMoves: !reconciliation || reconciliation.phase === 'complete',
      })
    )
    for (const path of seen) reported.delete(path)
    this.unscanned = false
    this.unsettled = new Set(found.dirty)
    const judged = await this.gate.judge(await this.staging.settleDeletes(found.ops), confirmed)
    this.ctx.set({ pending: judged.length })
    this.noteCollisions(found.collisions)

    let before = first
    if (first.held.length > 0) {
      const again = await this.pull(new Set([...found.dirty, ...this.kept]))
      before = fold(first, again)
      this.ctx.set({ cursor: again.cursor })
    }

    let sent: PushReport
    try {
      sent = await push(
        client,
        fs,
        state,
        { ...found, ops: judged },
        {
          ...common,
          ...(prefer === undefined ? {} : { prefer }),
          onProgress: (left) => this.ctx.set({ pending: left }),
          onCommitted: tally,
        }
      )
    } catch (error) {
      this.liveJournalKey = (await state.getJournal())?.idempotencyKey
      // A push that failed says nothing reliable about what is left: the scan's count stands.
      this.ctx.set({ pending: judged.length })
      throw error
    }
    // The confirmed deletes have gone out with the rest; the decision is done with.
    if (filed?.decision.kind === 'confirm') await this.holds.settle(filed.raw)
    const pushed = foldPush(replayed, sent)
    await this.staging.afterPush(judged)
    // The join's creates have been answered: whatever the pulls still hold is ordinary sync
    // from here, and no later create carries the preference.
    if (joining) await this.markJoin(false)
    this.joined = true
    this.kept = await this.leftBy(pushed)
    this.unsettled = new Set()
    this.ctx.set({
      pending: this.kept.size,
      headSeq: pushed.committed?.head_seq ?? this.ctx.status().headSeq,
    })

    let secondPull: PullReport | null = null
    // A stop during upload/commit still records its ledger and clears the journal. Once
    // those durable writes have finished there is no reason to start another server read.
    if (!this.ctx.stopping() && (pushed.committed !== null || before.held.length > 0)) {
      const holding = await this.holds.held()
      secondPull = await this.pull(new Set([...this.kept, ...holding]), undefined, holding)
      this.ctx.set({ cursor: secondPull.cursor })
    }
    if (!this.ctx.stopping()) await client.finishPull?.()
    // Include refusals discovered by either pull, not only directory publication.
    for (const refusal of client.directoryRefusals?.() ?? []) {
      pushed.rejected.push({
        op: { op: 'mkdir', path: refusal.path },
        path: refusal.path,
        code: refusal.code,
        message: refusal.message,
      })
      this.kept.add(refusal.path)
    }
    this.ctx.set({ pending: this.kept.size })
    for (const { op, code, message } of pushed.rejected) {
      const path =
        'path' in op
          ? op.path
          : op.op === 'move'
            ? op.to_path
            : 'file_id' in op
              ? (await state.byFileId(op.file_id))?.wirePath
              : undefined
      if (path !== undefined)
        await this.retries.failed(
          path,
          'push',
          new Error(`${code}: ${message}`),
          false,
          state,
          undefined,
          retryAttempt(op)
        )
    }
    for (const op of judged) {
      const path =
        op.op === 'create'
          ? op.path
          : op.op === 'move'
            ? op.to_path
            : (await state.byFileId(op.file_id))?.wirePath
      if (path !== undefined && !this.kept.has(path) && !pushed.rejected.some((r) => r.op === op))
        await this.retries.succeeded(path, 'push')
    }
    if (reconciliation && reconciliation.phase !== 'complete') {
      const unresolved =
        this.retries.list().length > 0 ||
        (await this.holds.list()).length > 0 ||
        sent.rejected.length > 0 ||
        sent.kept.length > 0 ||
        this.kept.size > 0 ||
        (secondPull ?? before).held.length > 0 ||
        this.ctx.stopping()
      reconciliation.phase = unresolved ? 'review' : 'complete'
      await transact(state, async (tx) => {
        await tx.setMeta?.(RECONCILIATION_KEY, JSON.stringify(reconciliation))
        if (reconciling && !unresolved) {
          await tx.setMeta?.(MEMBERS_KEY, null)
          await tx.setMeta?.(RECONCILING_KEY, null)
        }
      })
      this.ctx.set({ reconciliation })
    }
    for (const row of this.retries.list()) {
      if (!this.retries.ready(row.path)) continue
      if (
        (row.phase === 'scan' && !found.skipped.some((item) => item.path === row.path)) ||
        (row.phase === 'pull' &&
          !(secondPull ?? before).held.some((item) => item.path === row.path)) ||
        (row.phase === 'push' && !this.kept.has(row.path))
      )
        await this.retries.succeeded(row.path, row.phase)
    }
    return {
      pull: before,
      push: pushed,
      secondPull,
      collisions: found.collisions,
      deferred: await this.countStaged(),
      joined: joining,
    }
  }

  /** Whether the state holds a join a run started and no run finished (`JOIN_KEY`). */
  private async joinMarked(): Promise<boolean> {
    const state = this.ctx.opts.state
    return state.getMeta !== undefined && (await state.getMeta(JOIN_KEY)) !== null
  }

  private async rewindPull(): Promise<void> {
    const { client, state } = this.ctx.opts
    this.rewind = false
    await state.setCursor(0)
    await state.setMeta?.('pull-manifest-progress', null)
    await state.setMeta?.('pull-manifest-page', null)
    // After a crash, either the refusal remains visible or the durable cursor
    // forces a fresh manifest. Never retire the obligation before its rewind.
    if (this.retryRefusedDirectories) {
      await client.retryRefusedDirectories?.()
      this.retryRefusedDirectories = false
    }
  }

  private async scanWork<T>(work: () => Promise<T>): Promise<T> {
    this.ctx.scanning?.(true)
    try {
      return await work()
    } finally {
      this.ctx.scanning?.(false)
    }
  }

  /**
   * Mark a join begun, before its first pull, or finished, once its push is answered. A store
   * that keeps nothing beside its entries keeps no mark, and a restart there joins only while
   * the cursor is still 0.
   */
  private async markJoin(open: boolean): Promise<void> {
    await this.ctx.opts.state.setMeta?.(JOIN_KEY, open ? 'open' : null)
  }

  /** A line for each collision the scan has not held before; none for one it still holds. */
  private noteCollisions(collisions: CaseCollision[]): void {
    const now = new Set<string>()
    for (const { path, wirePath, with: synced } of collisions) {
      now.add(wirePath)
      if (this.collided.has(wirePath)) continue
      const points = (text: string) =>
        Array.from(text)
          .map((ch) => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase())
          .join(' ')
      this.ctx.log(
        (path.normalize('NFC') === synced.normalize('NFC')
          ? `scan: normalization collision: ${path} (${points(path)}): ${synced} (${points(synced)}); `
          : `scan: held ${path}: ${synced} is synced under the same name but for case; `) +
          'rename one of them to sync both'
      )
    }
    this.collided = now
  }

  /**
   * The server's cap and quota, as this run heard them. A refusal was given under some cap
   * and some quota; when either moves, the shas refused under the old ones get another try.
   */
  private learnLimits(maxFileBytes: number, quotaBytes: number | null): void {
    this.serverCap = maxFileBytes
    const under = `${this.ctx.opts.selective.maxFileBytes ?? ''}/${maxFileBytes}/${quotaBytes ?? ''}`
    if (this.refusedUnder !== null && this.refusedUnder !== under && this.refused.size > 0) {
      this.ctx.log(
        `push: the cap or the quota changed; ${this.refused.size} refused files get another try`
      )
      this.refused.clear()
    }
    this.refusedUnder = under
  }

  /** Explicit host retry may probe a refusal again; an unrelated due timer may not. */
  retryFileRefusals(): void {
    this.refused.clear()
  }

  /**
   * The wire paths a push left as unpushed typing, which no pull may write over until the
   * next scan has sent them: what it kept on the old base, and the files of every op the
   * server refused — the pusher leaves those exactly as the scan found them, so the next
   * scan sends them again. A refused move names both ends: the entry still says the old
   * path, and the file lies at the new one — unless the pusher has put it back, in which
   * case there is nothing left to send, and the pull may settle the file where the server did.
   */
  private async leftBy(pushed: PushReport): Promise<Set<string>> {
    const kept = new Set(pushed.kept)
    for (const { op } of pushed.rejected) {
      if (op.op === 'mkdir') {
        kept.add(op.path)
        continue
      }
      if (op.op === 'create') {
        // A refused create whose bytes the state now records under that path was sent again
        // in this very run — a replayed batch the server turned away, then the scan's own —
        // and there is nothing left of it to protect.
        if ((await this.ctx.opts.state.get(op.path))?.sha !== op.sha) kept.add(op.path)
        continue
      }
      const entry = await this.ctx.opts.state.byFileId(op.file_id)
      if (op.op === 'modify' && entry?.sha === op.sha) continue
      if (op.op === 'move' && entry !== null && (await this.back(entry))) continue
      if (entry !== null) kept.add(entry.wirePath)
      if (op.op === 'move') kept.add(op.to_path)
    }
    return kept
  }

  /** Whether the file is at its entry's path, as the entry describes it. */
  private async back(entry: StateEntry): Promise<boolean> {
    const have = await this.ctx.opts.fs.stat(entry.path)
    return have !== null && have.size === entry.size && have.mtime === entry.mtime
  }

  private async pull(
    dirty: Set<string>,
    recheck?: Set<string>,
    noted?: Set<string>
  ): Promise<PullReport> {
    const { client, fs, state } = this.ctx.opts
    const report = await pull(client, fs, state, {
      retries: this.retries,
      signal: this.ctx.signal?.(),
      protectMissing: true,
      ...(this.ctx.opts.transferBudget === undefined
        ? {}
        : { transferBudget: this.ctx.opts.transferBudget }),
      filter: this.filter,
      dirty,
      ...(recheck === undefined || recheck.size === 0 ? {} : { recheck }),
      ...(noted === undefined || noted.size === 0 ? {} : { noted }),
      expected: this.ctx.expected,
      onApplied: this.ctx.opts.onApplied,
      // Filed as each one is passed, before the pull saves a cursor past it.
      onAside: (path, wirePath) => this.asides.add(new Map([[path, wirePath]])),
      // Filed the same way, before the cursor moves past them.
      ...(this.ctx.opts.defer === undefined
        ? {}
        : {
            defer: this.ctx.opts.defer,
            onDefer: (staged: Staged[]) => this.staging.stage(staged),
          }),
      log: this.ctx.log,
    })
    if ((report.noted ?? 0) > 0) await this.holds.setNoted(true)
    if (report.settled !== undefined) await this.gate.release(report.settled)
    // A staged change whose file this pull moved on is out of date: it goes now, not at a push
    // that may never land.
    await this.staging.afterPull()
    await this.countStaged()
    return report
  }
}
