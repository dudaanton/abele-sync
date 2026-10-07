import type { ChangeItem, ManifestItem, ManifestResponse } from '@abele/sync-protocol'
import {
  changeProblem,
  DEFAULT_PREFETCH_BYTES,
  fetchChecked,
  pool,
  runsWithin,
  shaIndex,
} from './apply.js'
import type { VaultClient } from './client.js'
import { deferredSource, stageFrom, touchesDeferred, type Staged } from './defer.js'
import type { FileSystem } from './fs.js'
import { sha256 } from './hash.js'
import { PullPlacer } from './pullPlace.js'
import type { PullOptions, PullReport } from './puller.js'
import { isEngineOwn } from './selective.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * One run of the puller (see `puller.ts`): the manifest or the feed read page by page, each
 * page's changes sorted into taken, staged, passed over and held, and the cursor saved behind
 * them. Putting a taken change onto the disk is `pullPlace.ts`.
 */

/** The largest pages the feed and the manifest hand out. */
const CHANGES_PAGE = 1000
const MANIFEST_PAGE = 1000

/** How many blobs one page fetches at a time when the caller names no number. */
const DEFAULT_CONCURRENCY = 4

/** What a change will download: at most its size; a delete, none. */
const downloads = (change: ChangeItem): number =>
  change.op === 'delete' || change.sha === null ? 0 : (change.size ?? 0)

/**
 * A delete the feed never carried: a file back in scope that the manifest walk found gone from
 * the server (`PullOptions.recheck`), as a change to stage. Its version is none the server ever
 * gave, so nothing mistakes it for the version the entry already has.
 */
function goneFrom(entry: StateEntry, seq: number): ChangeItem {
  return {
    seq,
    file_id: entry.fileId,
    op: 'delete',
    path: entry.wirePath,
    prev_path: null,
    sha: null,
    size: null,
    mtime: null,
    version_id: `gone:${entry.versionId}`,
    kind: 'settings',
    actor: { kind: 'system', id: 'manifest', name: 'the server' },
    at: '',
  }
}

/** What a manifest item is, read as the change that would have created the file. */
function asCreate(item: ManifestItem): ChangeItem {
  return {
    seq: item.seq,
    file_id: item.file_id,
    op: 'create',
    path: item.path,
    prev_path: null,
    sha: item.sha,
    size: item.size,
    mtime: item.mtime,
    version_id: item.version_id,
    kind: item.kind,
    // The manifest says what a file is, not who last touched it or when.
    actor: { kind: 'system', id: 'manifest', name: 'manifest' },
    at: '',
  }
}

/**
 * The last change to each file on a page, in the order those last changes came. Everything
 * a change carries — path, sha, version — describes the file as it stands after it, so the
 * last one says all there is to say and the ones before it only move the cursor.
 */
function lastPerFile(changes: ChangeItem[]): ChangeItem[] {
  const last = new Map<string, ChangeItem>()
  for (const change of changes) last.set(change.file_id, change)
  return changes.filter((change) => last.get(change.file_id) === change)
}

/** One run of the puller: the adapters, the options and the report it is filling in. */
export class Puller {
  private readonly hash: (bytes: Uint8Array) => Promise<string>
  /** Where a taken change is put onto the disk; see `pullPlace.ts`. */
  private readonly placer: PullPlacer
  /** The highest seq this run has read through, held changes aside. */
  private reached = 0
  /** The seq of the earliest held change: where the next run must start again. */
  private firstHeld: number | null = null
  /** Set when the manifest walk held something, so the next run walks it again. */
  private walkAgain = false
  /** Every file id a manifest page or a feed page of this run named, applied or not. */
  private readonly seen = new Set<string>()
  /** Set while the manifest is walked. */
  private walking = false

  constructor(
    private readonly client: VaultClient,
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: PullOptions,
    private readonly report: PullReport
  ) {
    this.hash = opts.hash ?? sha256
    this.placer = new PullPlacer(client, fs, state, opts, this.hash)
  }

  /** Staged changes, one page's worth of work with no cursor to move. */
  async apply(changes: ChangeItem[]): Promise<void> {
    await this.page(changes)
  }

  async run(): Promise<void> {
    this.reached = this.report.cursor
    if (this.reached === 0) await this.bootstrap()
    await this.follow()
    if (this.report.bootstrapped && !this.walkAgain) await this.recheck()
  }

  /**
   * The files back in scope that neither the manifest nor the feed after it named: the server
   * deleted them while they were out of scope here. The manifest is read in path order and
   * the feed from the head its first page reported, so a file moved or restored while the
   * walk ran is in the feed, and only a file that is truly gone is in neither.
   */
  private async recheck(): Promise<void> {
    for (const fileId of this.opts.recheck ?? []) {
      if (this.seen.has(fileId)) continue
      const entry = await this.state.byFileId(fileId)
      if (entry === null) continue
      if (isEngineOwn(entry.wirePath) || this.opts.filter.excluded(entry.wirePath, entry.size)) {
        continue
      }
      if (this.opts.dirty.has(entry.wirePath) || (await this.placer.edited(entry))) {
        this.opts.log?.(
          `pull: ${entry.path} was deleted elsewhere while this device did not sync it; ` +
            'the edit made here goes back'
        )
        continue
      }
      if (this.defers(entry.wirePath)) {
        await this.stageAll([{ change: goneFrom(entry, this.reached), base: entry.versionId }])
        continue
      }
      if (await this.placer.drop(entry)) {
        this.report.applied++
        this.opts.log?.(
          `pull: ${entry.path} was deleted elsewhere while this device did not sync it`
        )
      }
    }
  }

  /** Whether the host stages changes to this path rather than have them written. */
  private defers(wirePath: string): boolean {
    return this.opts.defer?.(wirePath) ?? false
  }

  /** Hand staged changes to the host, and count them. */
  private async stageAll(staged: Staged[]): Promise<void> {
    if (staged.length === 0) return
    for (const { change } of staged) {
      this.opts.log?.(`pull: staged ${change.op} of ${change.path} at ${change.seq}`)
    }
    const fresh = await this.opts.onDefer?.(staged)
    this.report.deferred += typeof fresh === 'number' ? fresh : staged.length
  }

  /**
   * A device that has never synced walks the live files rather than the whole history,
   * and then follows the feed from the head the first page reported: anything committed
   * while the walk ran comes through the feed and lands on top.
   *
   * The cursor is written once, at the end: a walk that is cut off half way has applied
   * some of the vault, and a cursor at the head would mean the rest was never asked for.
   */
  private async bootstrap(): Promise<void> {
    this.report.bootstrapped = true
    let cursor: string | null = null
    let head: number | null = null
    this.walking = true
    try {
      do {
        const page: ManifestResponse = await this.client.manifest(cursor, MANIFEST_PAGE)
        head ??= page.head_seq
        await this.page(page.items.map(asCreate))
        cursor = page.next
      } while (cursor !== null)
    } finally {
      this.walking = false
    }
    // A manifest item's seq is where that file last changed, which may be far behind the
    // head; winding the cursor back to just before one would replay history the device has
    // no use for. A bootstrap that held anything is simply not finished, and says so by
    // leaving the cursor at 0: the next run walks the manifest again, and everything it
    // did apply is recognised by its version and skipped.
    this.walkAgain = this.firstHeld !== null
    this.reached = head ?? 0
    await this.save()
  }

  /** The feed, page after page, until the last one handed out reaches the head. */
  private async follow(): Promise<void> {
    for (;;) {
      const page = await this.client.changes(this.reached, CHANGES_PAGE)
      await this.page(page.items)
      this.reached = page.next_since
      await this.save()
      if (page.items.length === 0 || page.next_since >= page.head_seq) return
    }
  }

  /**
   * One page: the last change to each file, its paths checked; then the blobs those will
   * want, fetched a few at a time; and then every change in seq order. Fetching first is
   * what keeps the downloads parallel and the writes ordered. The page is taken in runs whose
   * bytes fit `prefetchBytes`, each fetched, written and let go before the next, so what is
   * held at once is bounded by bytes and not by the page's thousand files.
   */
  private async page(changes: ChangeItem[]): Promise<void> {
    if (changes.length === 0) return
    for (const change of changes) this.seen.add(change.file_id)
    const latest = lastPerFile(changes)
    this.report.skipped += changes.length - latest.length
    const wanted = latest.filter((change) => this.acceptable(change))
    if (wanted.length === 0) return
    // Staged before anything is fetched: a staged change wants no bytes yet.
    const taking: ChangeItem[] = []
    const staged: Staged[] = []
    for (const change of wanted) {
      const stage = await this.staging(change)
      if (stage === null) taking.push(change)
      else staged.push(stage)
    }
    await this.stageAll(staged)
    if (taking.length === 0) return
    const local = await shaIndex(this.state)
    const budget = this.opts.prefetchBytes ?? DEFAULT_PREFETCH_BYTES
    for (const run of runsWithin(taking, downloads, budget)) {
      const fetched = await this.prefetch(run, local)
      for (const change of run) await this.take(change, fetched, local)
    }
  }

  /**
   * The change as the host stages it, or null when it is taken as usual: the host stages
   * nothing there, this device does not sync it, already has it, or already holds its bytes
   * where they belong — then taking it writes nothing, and only files what is already here.
   */
  private async staging(change: ChangeItem): Promise<Staged | null> {
    if (this.opts.defer === undefined) return null
    const entry = await this.state.byFileId(change.file_id)
    if (this.passedOver(change)) {
      return deferredSource(this.opts.defer, change, entry) ? stageFrom(change, entry) : null
    }
    const touches = touchesDeferred(this.opts.defer, change.path, change.prev_path, entry?.wirePath)
    if (!touches) return null
    if (entry?.versionId === change.version_id) return null
    if (await this.inPlace(change, entry)) return null
    return stageFrom(change, entry)
  }

  /** Whether the disk already holds this change's bytes at its path, with nothing to move. */
  private async inPlace(change: ChangeItem, entry: StateEntry | null): Promise<boolean> {
    if (change.op === 'delete' || change.sha === null) return false
    if (entry !== null) {
      if (entry.wirePath !== change.path || entry.sha !== change.sha) return false
      if (this.opts.dirty.has(entry.wirePath)) return false
      return !(await this.placer.edited(entry)) && (await this.fs.stat(entry.path)) !== null
    }
    if ((await this.state.get(change.path)) !== null) return false
    if (this.opts.dirty.has(change.path)) return false
    const there = await this.fs.stat(change.path)
    if (there === null) return false
    try {
      return (await this.hash(await this.fs.read(change.path))) === change.sha
    } catch {
      return false
    }
  }

  /**
   * Whether the change names paths this device will touch a disk with. One that does not
   * is a server not keeping to the protocol, or someone speaking for it; it is passed over
   * and said so, and the cursor moves past it like any other change this device wants no
   * part of. Holding it would only have the next pull refuse it again.
   */
  private acceptable(change: ChangeItem): boolean {
    const problem = changeProblem(change)
    if (problem === null) return true
    this.report.skipped++
    this.opts.log?.(`pull: skipped ${change.op} at ${change.seq}: ${problem}`)
    return false
  }

  /**
   * Where the cursor stands after a page: at what was read, or just before the earliest
   * change this run held, so the next run fetches that change again.
   */
  private async save(): Promise<void> {
    this.report.cursor = this.nextCursor()
    await this.state.setCursor(this.report.cursor)
  }

  private nextCursor(): number {
    if (this.walkAgain) return 0
    return this.firstHeld === null ? this.reached : this.firstHeld - 1
  }

  /* ── One change ──────────────────────────────────────────────────────── */

  private async take(
    change: ChangeItem,
    fetched: Map<string, Uint8Array>,
    local: Map<string, StateEntry>
  ): Promise<void> {
    const entry = await this.state.byFileId(change.file_id)
    if (this.passedOver(change)) {
      await this.passOver(change, entry)
      return
    }
    // Already here: a change re-read on the way back to the head, or one this device made.
    if (entry?.versionId === change.version_id) {
      await this.placer.pending.settled(change)
      this.report.skipped++
      return
    }
    if (touchesDeferred(this.opts.defer, change.path, change.prev_path, entry?.wirePath)) {
      // An earlier equality probe permits metadata adoption only, never a later disk write.
      if (await this.placer.adoptExisting(change, entry)) this.report.applied++
      else await this.stageAll([stageFrom(change, entry)])
      return
    }
    if (await this.placer.adopt(change, entry)) {
      this.report.applied++
      return
    }
    if (this.isDirty(change, entry)) {
      if (await this.goneBoth(change, entry)) return
      if (this.walking && this.isNoted(change, entry)) this.note(change)
      else this.hold(change)
      return
    }

    if (change.op === 'delete' || change.sha === null) {
      // A delete of a file this device never had is nothing to do, not something done.
      if (entry === null) this.report.skipped++
      else if (await this.placer.edited(entry)) this.hold(change)
      else if (await this.placer.drop(entry)) this.report.applied++
      else this.hold(change)
      return
    }
    if (this.placer.lying.has(change.sha)) {
      this.hold(change)
      return
    }
    const placed = await this.placer.place(change, change.sha, entry, fetched, local)
    if (placed === 'aside') this.report.skipped++
    else if (placed) this.report.applied++
    else this.hold(change)
  }

  /**
   * A change this device does not sync. Usually there is nothing to do — but a file the
   * server moved out of the synced set takes the file with it, even when a later edit on the
   * same page hides the move: to this device it has gone,
   * and its entry goes with it, or the next scan would push it straight back at its old path.
   */
  private async passOver(change: ChangeItem, entry: StateEntry | null): Promise<void> {
    // A move the entry already stands at is this device's own coming back — a copy kept here
    // under a head over the cap, moved here — not a file leaving the synced set.
    if (entry === null || entry.wirePath === change.path) {
      this.report.skipped++
      return
    }
    if (deferredSource(this.opts.defer, change, entry)) {
      await this.stageAll([stageFrom(change, entry)])
      return
    }
    // Not over a local edit, though: that is the engine's to push and settle first.
    if (this.isDirty(change, entry) || (await this.placer.edited(entry))) {
      this.hold(change)
      return
    }
    if (await this.placer.drop(entry)) this.report.applied++
    else this.hold(change)
  }

  /** A change for a file this device does not sync, or for the engine's own state. */
  private passedOver(change: ChangeItem): boolean {
    // The filter owns the engine's own paths too; the guard is here so no filter can lose them.
    return isEngineOwn(change.path) || this.opts.filter.excluded(change.path, change.size ?? 0)
  }

  /**
   * Whether applying the change would write over an edit this device has not pushed: the
   * file it names has one, or the path it lands on has one, or the path it is leaving does.
   */
  private isDirty(change: ChangeItem, entry: StateEntry | null): boolean {
    const dirty = this.opts.dirty
    if (entry !== null && dirty.has(entry.wirePath)) return true
    if (dirty.has(change.path)) return true
    return change.prev_path !== null && dirty.has(change.prev_path)
  }

  /** Whether the change touches a path whose delete the guard holds. */
  private isNoted(change: ChangeItem, entry: StateEntry | null): boolean {
    const noted = this.opts.noted
    if (noted === undefined || noted.size === 0) return false
    if (entry !== null && noted.has(entry.wirePath)) return true
    return noted.has(change.path) || (change.prev_path !== null && noted.has(change.prev_path))
  }

  /**
   * A delete from the server of a file whose own delete the guard holds here, and which is still
   * gone from this disk: both sides agree, so there is nothing to hold the change for. The entry
   * goes and the id is reported settled, so the engine takes it out of the hold. Held instead,
   * the change would pin the cursor until someone decided, and every sync would read the feed
   * again from there.
   */
  private async goneBoth(change: ChangeItem, entry: StateEntry | null): Promise<boolean> {
    if (change.op !== 'delete' && change.sha !== null) return false
    if (entry === null || !this.isNoted(change, entry)) return false
    if ((await this.fs.stat(entry.path)) !== null) return false
    this.opts.expected.clear(entry.path)
    await this.state.delete(entry.path)
    this.report.settled = [...(this.report.settled ?? []), entry.fileId]
    this.opts.log?.(`pull: ${entry.path} was deleted elsewhere too; its held delete is settled`)
    return true
  }

  /** Passed over for a held delete, and said so: see `PullOptions.noted`. */
  private note(change: ChangeItem): void {
    this.report.noted = (this.report.noted ?? 0) + 1
    this.opts.log?.(`pull: passing over ${change.op} of ${change.path}: its delete is held`)
  }

  private hold(change: ChangeItem): void {
    this.report.held.push(change)
    this.firstHeld = this.firstHeld === null ? change.seq : Math.min(this.firstHeld, change.seq)
    this.opts.log?.(`pull: holding ${change.op} of ${change.path} at ${change.seq}`)
  }

  /* ── Bytes ───────────────────────────────────────────────────────────── */

  /**
   * The blobs this page will want, fetched `concurrency` at a time and held until the
   * changes are applied in order. The verdicts here are only a guess at what the apply
   * will need — a change held for a reason only the disk knows costs one wasted fetch,
   * and one that turns out to need bytes nobody fetched simply fetches them itself.
   *
   * It is handed one run of a page at a time (`runsWithin`), so what it holds is at most
   * `prefetchBytes`, or the one file of a run bigger than that.
   */
  private async prefetch(
    changes: ChangeItem[],
    local: Map<string, StateEntry>
  ): Promise<Map<string, Uint8Array>> {
    const wanted: string[] = []
    const seen = new Set<string>()
    for (const change of changes) {
      const sha = change.sha
      if (sha === null || change.op === 'delete') continue
      if (seen.has(sha) || local.has(sha)) continue
      if (this.passedOver(change)) continue
      const entry = await this.state.byFileId(change.file_id)
      if (entry?.versionId === change.version_id || entry?.sha === sha) continue
      if (this.isDirty(change, entry)) continue
      // Something on disk that nothing has synced: a device syncing over a copy of the vault
      // it was handed, or somebody's unsynced work. The apply adopts the first and holds the
      // second, and wants no bytes from the server for either.
      if (
        (await this.fs.stat(change.path)) !== null &&
        (await this.state.get(change.path)) === null
      )
        continue
      seen.add(sha)
      wanted.push(sha)
    }

    const fetched = new Map<string, Uint8Array>()
    await pool(wanted, this.opts.concurrency ?? DEFAULT_CONCURRENCY, async (sha) => {
      const bytes = await fetchChecked(this.client, sha, this.hash)
      if (bytes === null) this.placer.disbelieve(sha)
      else fetched.set(sha, bytes)
    })
    return fetched
  }
}
