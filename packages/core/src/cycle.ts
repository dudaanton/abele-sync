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
import type { FileInfo } from './fs.js'
import { sha256 } from './hash.js'
import { pull, type PullReport } from './puller.js'
import { push, resumeJournal, type PushReport, type Refusal } from './pusher.js'
import { scan, type CaseCollision, type ScanFilter } from './scanner.js'
import { AsideMarks, ScopeMarks, type ScopeRecord } from './scope.js'
import { isExcluded } from './selective.js'
import { Staging } from './staging.js'
import type { StateEntry } from './state.js'
import type { WatchReports } from './watchReports.js'

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
  readonly filter: ScanFilter
  /**
   * The vault's own cap on a file, as the server last said it: a file over it is excluded
   * here, as it would be by the local cap, rather than uploaded to be refused.
   */
  private serverCap: number | null = null
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
  /** Set once a run has started or ended with the cursor above 0: no preference is sent again. */
  private joined = false
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
    const scriptsFolder = opts.scriptsFolder ?? DEFAULT_SCRIPTS_FOLDER
    this.filter = {
      excluded: (path, size) =>
        (this.serverCap !== null && size > this.serverCap) ||
        isExcluded(path, size, opts.selective, scriptsFolder) ||
        (opts.ignore?.ignores(path) ?? false),
    }
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
  recordScope(): Promise<void> {
    const { opts } = this.ctx
    const record: ScopeRecord = {
      selective: opts.selective,
      scriptsFolder: opts.scriptsFolder ?? DEFAULT_SCRIPTS_FOLDER,
      ...(opts.ignoreText === undefined ? {} : { ignore: opts.ignoreText }),
    }
    const marking = this.scope
      .record(opts.fs, structuredClone(record), this.filter)
      .catch((error: unknown) => {
        // A lapsed claim stops the run here, as at any other guarded step.
        if (error instanceof EngineError && error.code === 'lost') throw error
        this.ctx.log(`scope: not recorded: ${messageOf(error)}`)
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
    const log = this.ctx.log
    const common = {
      expected: this.ctx.expected,
      refused: this.refused,
      filter: this.filter,
      beforeUpload: this.ctx.opts.beforeUpload,
      onSettled: this.ctx.opts.onSettled,
      // A push answered with the server's bytes for a staged path stages them, as a pull would
      ...(this.ctx.opts.defer === undefined
        ? {}
        : {
            defer: this.ctx.opts.defer,
            onDefer: (staged: Staged[]) => this.staging.stage(staged),
          }),
      log,
    }

    // Read before a rescan winds the cursor back: only a device that has not joined yet joins.
    // A join a process started and did not finish is marked in the state, so a restart after
    // its first pull moved the cursor still joins, with the side the person chose.
    const marked = await this.joinMarked()
    if ((await state.getCursor()) > 0 && !marked) this.joined = true
    const joining = !this.joined
    const prefer = joining ? this.ctx.opts.joinPrefer : undefined
    if (joining && !marked) await this.markJoin(true)
    if (prefer !== undefined) log(`sync: joining the vault; where both hold a file, ${prefer} wins`)

    // Before the server is asked anything, so a narrowing is recorded even offline. A file
    // that came back into scope is settled by a manifest walk, so a widening always walks it,
    // whether or not the host asked for the rescan.
    await this.recordScope()
    const scope = await this.scope.review(fs, this.filter)
    for (const path of scope.forgotten) {
      log(`scope: ${path} went while this device did not sync it; the vault's copy is kept`)
    }
    if (scope.forgotten.length > 0 || scope.recheck.size > 0) this.rewind = true
    if (await this.asides.due(fs, this.filter)) {
      log('scope: a local file a server file was passed over for has gone; walking the vault')
      this.rewind = true
    }
    // Read through the guarded state, and every step it leads to is a guarded write: a daemon
    // whose lock lapsed takes nothing of it (see `stillHeld`).
    const filed = await this.holds.decision()
    // What went out before a decision counts no more toward the guard.
    if (filed !== null) await this.holds.resetTally()
    const confirmed = new Set(filed?.decision.kind === 'confirm' ? filed.decision.fileIds : [])
    // Counted as each commit lands, so a push cut off half way still counts what it sent — and
    // so does a replay, whose batch may have landed before its answer was lost.
    const tally = (ops: readonly CommitOp[]): Promise<void> => this.gate.tallySent(ops, confirmed)
    if (filed?.decision.kind === 'restore') await this.gate.putBack(filed.decision)

    if (this.rewind) {
      this.rewind = false
      await state.setCursor(0)
    }
    // Carried out once the feed is rewound: killed before that, the next run does it again.
    if (filed?.decision.kind === 'restore') await this.holds.settle(filed.raw)
    const vault = await client.state()
    this.ctx.set({ headSeq: vault.head_seq, cursor: await state.getCursor() })
    this.learnLimits(vault.settings.max_file_bytes, vault.settings.quota_bytes)

    // A batch the last run never finished recording goes first: a scan taken over it would
    // describe a disk the state does not know about yet.
    const replayed = await resumeJournal(client, fs, state, { ...common, onCommitted: tally })
    for (const path of replayed?.kept ?? []) this.kept.add(path)

    // The watcher's latest batch, without waiting for the debounce: what it holds is exactly
    // what the pull must not write over.
    const reported = this.ctx.watch.reported
    await this.ctx.watch.examine()
    const holding = await this.holds.held()
    const protect = new Set([...this.kept, ...reported, ...this.unsettled, ...holding])
    for (const path of await this.guess()) protect.add(path)
    const first = await this.pull(protect, scope.recheck, holding)
    this.ctx.set({ cursor: first.cursor })
    await this.staging.tidy(protect)
    // A walk that finished has confirmed every file back in scope, or taken it.
    if (first.bootstrapped && first.cursor > 0) await this.scope.settle(scope.recheck)

    // Paths reported before the scan are taken in by it; anything reported while it reads
    // the tree may or may not be, and stays for the next run.
    const seen = [...reported]
    // A lost note's text is only on the server now; it is read back to tell an edited rename
    // from a delete and an unrelated create (`likeness.ts`).
    const previous = (entry: StateEntry): Promise<Uint8Array | null> =>
      fetchChecked(client, entry.sha, sha256)
    const found = await scan(fs, state, this.filter, { log, previous })
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
      this.ctx.log(
        `scan: held ${path}: ${synced} is synced under the same name but for case; ` +
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
      onPersonalNoteApplied: this.ctx.opts.onPersonalNoteApplied,
      filter: this.filter,
      dirty,
      ...(recheck === undefined || recheck.size === 0 ? {} : { recheck }),
      ...(noted === undefined || noted.size === 0 ? {} : { noted }),
      expected: this.ctx.expected,
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

  /**
   * Which synced files may hold an edit nobody has reported: a fresh process has no watcher
   * history, and a host with no watcher never will. One listing, no hashing — a file whose
   * size and mtime still match its entry is left to the scan, and one that is gone counts, so
   * a local delete is not undone by a pull before the push can send it.
   */
  private async guess(): Promise<Set<string>> {
    const dirty = new Set<string>()
    if (!this.unscanned && this.ctx.watching()) return dirty
    const disk = new Map<string, FileInfo>()
    for await (const info of this.ctx.opts.fs.list()) disk.set(info.path, info)
    for await (const entry of this.ctx.opts.state.all()) {
      const info = disk.get(entry.path)
      if (info === undefined || info.size !== entry.size || info.mtime !== entry.mtime) {
        dirty.add(entry.wirePath)
      }
    }
    return dirty
  }
}
