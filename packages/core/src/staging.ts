import { normalisePath, type ChangeItem, type CommitOp } from '@abele/sync-protocol'
import type { VaultClient } from './client.js'
import { deferredSource, StagedChanges, touchesDeferred, type Staged } from './defer.js'
import { sha256 } from './hash.js'
import type { ExpectedWrites } from './echo.js'
import type { FileSystem } from './fs.js'
import { applyStaged } from './puller.js'
import type { ScanFilter } from './scanner.js'
import { isEngineOwn } from './selective.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * What the engine does with its staged changes (`defer.ts`) around a sync and at the host's
 * word: apply them, keep this device's files over them, let go of the ones it no longer stages,
 * and settle them against what a scan or a push found. The engine runs every one of these in its
 * run queue, over its guarded adapters, so none runs beside a sync or after the claim lapsed.
 */

/** What `applyDeferred` did: the wire paths written, and those a local edit stood in the way of. */
export interface DeferredApplied {
  applied: string[]
  /** Paths changed here since the change was staged: this device's edit, which the scan sends. */
  skipped: string[]
  /**
   * Only when the host named the versions it showed: the staged changes at none of them —
   * never shown, or replaced by a later change since — left staged and unwritten, for the host
   * to ask about.
   */
  unshown?: ChangeItem[]
}

/**
 * What `keepLocal` did: the wire paths whose local copy goes out over the staged change, and
 * those only the other side has, left there and absent here.
 */
export interface DeferredKept {
  kept: string[]
  /** Files this disk does not have: nothing is sent for them, and nothing is deleted anywhere. */
  left: string[]
  /**
   * Only when the host named the versions it showed: the staged changes among those named
   * whose version is none of them — replaced since they were shown, or never shown — left
   * staged, for the host to ask about.
   */
  unshown?: ChangeItem[]
}

/** The staged records split by whether their current version is one the host showed. */
function byShown(
  list: Staged[],
  shown: ReadonlySet<string> | null
): { act: Staged[]; unshown: Staged[] } {
  if (shown === null) return { act: list, unshown: [] }
  return {
    act: list.filter(({ change }) => shown.has(change.version_id)),
    unshown: list.filter(({ change }) => !shown.has(change.version_id)),
  }
}

/** Whether one of the ops committed was for this staged change's file. */
function sentFor(sent: readonly CommitOp[], change: ChangeItem, entry: StateEntry | null): boolean {
  return sent.some((op) =>
    op.op === 'create'
      ? op.path === change.path || op.path === entry?.wirePath
      : op.file_id === change.file_id
  )
}

/** What the log says of a staged change that went out of date, and why it did. */
function supersededLine(change: ChangeItem, entry: StateEntry | null, ours: boolean): string {
  const { path } = change
  const from = change.actor.name
  if (entry?.versionId === change.version_id) {
    return `sync: the change to ${path} from ${from} is on this device now`
  }
  if (!ours) return `sync: the change to ${path} from ${from} was replaced by a later one`
  return entry !== null && entry.sha === change.sha
    ? `sync: the change to ${path} from ${from} was newer than the one made here, and is on this device now`
    : `sync: your change to ${path} on this device replaced the one from ${from}`
}

/** The engine's adapters and settings, as staging needs them. */
export interface StagingContext {
  client: VaultClient
  fs: FileSystem
  state: StateStore
  filter: ScanFilter
  expected: ExpectedWrites
  /** The host's `defer`; absent stages nothing. */
  defer: ((wirePath: string) => boolean) | undefined
  log: (line: string) => void
}

export class Staging {
  readonly records: StagedChanges

  constructor(private readonly ctx: StagingContext) {
    this.records = new StagedChanges(ctx.state)
  }

  /** The changes staged, oldest first, as the server gave them. */
  async list(): Promise<ChangeItem[]> {
    return (await this.records.list()).map((one) => one.change)
  }

  count(): Promise<number> {
    return this.records.count()
  }

  /** Stage what a pull handed over; the number that were news. */
  stage(staged: Staged[]): Promise<number> {
    return this.records.stage(staged)
  }

  /**
   * Write the staged changes as a pull would, never over what `dirty` names or a file changed
   * here since. What was written, or needed nothing, is forgotten; what was skipped keeps its
   * record until this device's commit for it lands. With `shown`, only the records whose
   * current version is in it are written; the rest stay staged and come back as `unshown`.
   */
  async apply(
    dirty: Set<string>,
    shown: ReadonlySet<string> | null = null
  ): Promise<DeferredApplied> {
    await this.settle(null)
    const { act: list, unshown } = byShown(await this.records.list(), shown)
    const rest = shown === null ? {} : { unshown: unshown.map((one) => one.change) }
    if (unshown.length > 0) {
      this.ctx.log(
        `sync: ${unshown.length} staged changes were not the ones shown, and stay staged`
      )
    }
    if (list.length === 0) return { applied: [], skipped: [], ...rest }
    const held = await this.write(list, dirty)
    const done = list.filter((one) => !held.has(one.change.file_id))
    const skipped = list.filter((one) => held.has(one.change.file_id))
    await this.records.drop(done.map((one) => one.change.file_id))
    this.ctx.log(
      `sync: applied ${done.length} staged changes` +
        (skipped.length === 0 ? '' : `; ${skipped.length} changed here since, and go out as edits`)
    )
    return {
      applied: done.map((one) => one.change.path),
      skipped: skipped.map((one) => one.change.path),
      ...rest,
    }
  }

  /**
   * Keep this device's files over the staged changes at `paths` (all when null; a move is named
   * by either end). For a file this disk has, the entry is moved to the server's version and
   * the disk left alone, so the next scan sends this disk as a change on the head. A file only
   * the server has is left alone on both sides: its record goes and nothing is sent, so keeping
   * never deletes a file on another device. With `shown`, only
   * the records whose current version is in it are kept; the rest of those named stay staged
   * and come back as `unshown`.
   */
  async keep(
    paths: ReadonlySet<string> | null,
    shown: ReadonlySet<string> | null = null
  ): Promise<DeferredKept> {
    // One out of date is not kept either: its entry already names a later version, and moving it
    // to the staged one would send this disk as a change on a head that is not the head.
    await this.settle(null)
    const named = (await this.records.list()).filter(
      ({ change }) =>
        paths === null ||
        paths.has(change.path) ||
        (change.prev_path !== null && paths.has(change.prev_path))
    )
    const { act: list, unshown } = byShown(named, shown)
    if (unshown.length > 0) {
      this.ctx.log(
        `sync: ${unshown.length} staged changes were not the ones shown, and stay staged`
      )
    }
    const kept: Staged[] = []
    const left: Staged[] = []
    for (const one of list) {
      const outcome = await this.keepOne(one)
      if (outcome === 'kept') kept.push(one)
      else if (outcome === 'left') left.push(one)
    }
    await this.records.drop([...kept, ...left].map((one) => one.change.file_id))
    if (kept.length > 0)
      this.ctx.log(`sync: keeping this device's copy of ${kept.length} staged files`)
    if (left.length > 0) {
      this.ctx.log(
        `sync: ${left.length} staged files exist only on the other side, and are left there`
      )
    }
    return {
      kept: kept.map((one) => one.change.path),
      left: left.map((one) => one.change.path),
      ...(shown === null ? {} : { unshown: unshown.map((one) => one.change) }),
    }
  }

  /**
   * Staged changes this device no longer stages: out of its scope now, so dropped — the scope
   * marks bring such a file back through a manifest walk when the scope widens, staged afresh —
   * or in scope and no longer deferred by the host, so written now as a pull would.
   */
  async tidy(dirty: Set<string>): Promise<void> {
    await this.settle(null)
    const list = await this.records.list()
    if (list.length === 0) return
    const outOfScope: string[] = []
    const release: Staged[] = []
    for (const one of list) {
      const { change } = one
      const entry = await this.ctx.state.byFileId(change.file_id)
      const keepsSource =
        entry !== null &&
        deferredSource(this.ctx.defer, change, entry) &&
        !this.ctx.filter.excluded(entry.wirePath, entry.size)
      if (
        !keepsSource &&
        (isEngineOwn(change.path) || this.ctx.filter.excluded(change.path, change.size ?? 0))
      ) {
        outOfScope.push(change.file_id)
        continue
      }
      const staging = touchesDeferred(
        this.ctx.defer,
        change.path,
        change.prev_path,
        entry?.wirePath
      )
      if (!staging) release.push(one)
    }
    await this.records.drop(outOfScope)
    if (release.length === 0) return
    const held = await this.write(release, dirty)
    await this.records.drop(
      release.filter((one) => !held.has(one.change.file_id)).map((one) => one.change.file_id)
    )
  }

  /**
   * A scan's already-settled local outcomes wait for approval, rather than being pushed again.
   * Deletes whose staged change is the server's own delete are gone on both sides: their entry
   * and record go, and there is nothing for the delete guard to count.
   */
  async settleDeletes(ops: CommitOp[]): Promise<CommitOp[]> {
    const list = await this.records.list()
    if (list.length === 0) return ops
    const gone = new Set(
      list
        .filter(({ change }) => change.op === 'delete' || change.sha === null)
        .map(({ change }) => change.file_id)
    )
    const waiting = new Set<string>()
    const paths = new Set<string>()
    for (const one of list) {
      const settled = one.settled
      if (settled === undefined) continue
      const here = await this.ctx.fs.stat(settled.path)
      const same =
        settled.sha === null
          ? here === null
          : here !== null && (await sha256(await this.ctx.fs.read(settled.path))) === settled.sha
      if (same) {
        waiting.add(one.change.file_id)
        paths.add(normalisePath(settled.path))
      }
    }
    const settled: string[] = []
    const send: CommitOp[] = []
    for (const op of ops) {
      // This exact local outcome was already settled by a push. Only a new local edit or
      // an explicit staging decision can send it again; restart and missing history cannot.
      if (op.op === 'create' ? paths.has(op.path) : waiting.has(op.file_id)) continue
      if (op.op !== 'delete' || !gone.has(op.file_id)) {
        send.push(op)
        continue
      }
      const entry = await this.ctx.state.byFileId(op.file_id)
      if (entry !== null) await this.ctx.state.delete(entry.path)
      settled.push(op.file_id)
    }
    if (settled.length > 0) {
      await this.records.drop(settled)
      this.ctx.log(`sync: ${settled.length} files deleted here were deleted on the server too`)
    }
    return send
  }

  /**
   * After a pull: a staged change whose file the pull has moved on — a later change taken as
   * usual, its bytes already here — is out of date, and goes now rather than wait for a push
   * that may never land.
   */
  afterPull(): Promise<void> {
    return this.settle(null)
  }

  /**
   * After a push of `sent`: a staged change whose file a commit of this device's has moved since
   * is done with — the edit made here went out over it, and the server settled the two, which
   * the pusher has already put on this disk or staged in its place.
   */
  afterPush(sent: readonly CommitOp[]): Promise<void> {
    return this.settle(sent)
  }

  /**
   * Drop every staged change whose file's entry no longer stands at the version it was staged
   * against. The pulls never move such an entry except to take a later change as usual, and a
   * push moves it only by landing a commit for the file; either way the change describes a
   * version the file has left, and writing it would put older bytes over the newer head. `sent`
   * is what this run committed, which says whose the later version is; null when nothing did.
   */
  private async settle(sent: readonly CommitOp[] | null): Promise<void> {
    const { state } = this.ctx
    // A batch still in the journal has not been recorded: the entries of its files are not yet
    // what its answer makes them, so a change staged against that answer is not out of date.
    // The replay records the batch and settles it then.
    const journal = await state.getJournal()
    const superseded: string[] = []
    for (const { change, base } of await this.records.list()) {
      const entry = await state.byFileId(change.file_id)
      if ((entry?.versionId ?? null) === base) continue
      if (journal !== null && sentFor(journal.ops, change, entry)) continue
      superseded.push(change.file_id)
      this.ctx.log(supersededLine(change, entry, sent !== null && sentFor(sent, change, entry)))
    }
    await this.records.drop(superseded)
  }

  /**
   * Apply these as a pull would; the file ids a local edit or the disk held back. Every caller
   * settles first, so none of these is out of date: `settle` has dropped those.
   */
  private async write(list: Staged[], dirty: Set<string>): Promise<Set<string>> {
    const { client, fs, state, filter, expected, log } = this.ctx
    // A missing tracked source is a later local deletion/rename, except when a losing delete
    // already established that absence as the staged outcome. Check again at placement too.
    const preserveMissing = new Set(
      list.filter((one) => one.settled?.sha !== null).map((one) => one.change.file_id)
    )
    const report = await applyStaged(
      client,
      fs,
      state,
      list.map((one) => one.change),
      { filter, dirty, expected, log, preserveMissing }
    )
    return new Set(report.held.map((change) => change.file_id))
  }

  /**
   * One file's entry moved to the server's version of it, the disk left alone. `left` when this
   * disk does not have the file, so there is nothing of this device's to keep: the entry stays
   * as it is and nothing is sent for the change; `blocked` when another synced file holds the
   * path here, whose own staged change must be settled first.
   */
  private async keepOne(one: Staged): Promise<'kept' | 'left' | 'blocked'> {
    const { change } = one
    const { fs, state } = this.ctx
    const entry = await state.byFileId(change.file_id)
    if (change.op === 'delete' || change.sha === null) {
      // The server has no such file: this disk's copy, if any, goes back as a fresh one.
      if (entry !== null) await state.delete(entry.path)
      return 'kept'
    }
    const sha = change.sha
    const target =
      entry !== null && normalisePath(entry.path) === change.path ? entry.path : change.path
    // Checked before anything is touched. A file the server has and this disk lacks — installed
    // there, or deleted here since the change was staged — is not this device's to send a delete
    // for: an entry that is there stays as it was, so what the scan sends for it is this
    // device's own delete, judged by the delete guard like any other.
    const here =
      (await fs.stat(target)) !== null || (entry !== null && (await fs.stat(entry.path)) !== null)
    if (!here) {
      // A rejected server move may follow a different, refused local move. Neither named
      // path exists here, but the stale source entry would pair the local file into that
      // same refused move forever. Detach it so any local copy uploads as a fresh file.
      if (entry !== null && (one.settled?.sha === null || entry.wirePath !== change.path)) {
        await state.delete(entry.path)
      }
      return 'left'
    }
    if (entry !== null && entry.path !== target && (await fs.stat(target)) === null) {
      // Rejecting a move keeps the old local path, not an imaginary file at the new path.
      // Recording the absent target would make the scanner delete the remote plugin. Let
      // the old local file upload as its own file instead, leaving the remote target intact.
      await state.delete(entry.path)
      return 'kept'
    }
    const occupant = await state.get(target)
    if (occupant !== null && occupant.fileId !== change.file_id) {
      this.ctx.log(`sync: ${change.path} is held here by another file; its staged change stays`)
      return 'blocked'
    }
    await state.transaction(async () => {
      if (entry !== null && entry.path !== target) await state.delete(entry.path)
      await state.put({
        path: target,
        wirePath: change.path,
        fileId: change.file_id,
        versionId: change.version_id,
        sha,
        size: change.size ?? 0,
        // No file has this mtime, so the scan reads the file rather than trust the entry.
        mtime: -1,
      })
    })
    return 'kept'
  }
}
