import { pathOccupant } from './pathOccupant.js'
import { olderPull, recordPull } from './pullHistory.js'
import { transact } from './stateTransaction.js'
import { replayAuthority } from './replayAuthority.js'
import { isFileFailure } from './fileRetry.js'
import {
  AbeleError,
  type ChangeItem,
  type ManifestItem,
  type ManifestResponse,
} from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import {
  changeProblem,
  DEFAULT_PREFETCH_BYTES,
  fetchChecked,
  pool,
  runsWithin,
  shaIndex,
} from './apply.js'
import type { EngineClient } from './engineClient.js'
import { deferredSource, stageFrom, touchesDeferred, type Staged } from './defer.js'
import type { FileSystem } from './fs.js'
import { fingerprintFile } from './fs.js'
import { sha256 } from './hash.js'
import { PullPlacer } from './pullPlace.js'
import type { PullOptions, PullReport } from './puller.js'
import { isEngineOwn } from './selective.js'
import type { StateEntry, StateStore } from './state.js'
import { checkCancellation } from './cancellation.js'
import { GENERATION_KEY } from './restoreGeneration.js'

import { PullHolds, importLegacyPullHolds } from './pullHolds.js'
const MANIFEST_PROGRESS = 'pull-manifest-progress'
const MANIFEST_PAGE_DATA = 'pull-manifest-page'
interface ManifestProgress {
  generation: string | null
  scope: string | null
  recheck: string[]
  page: ManifestResponse
  head: number
  completed: string[]
  seen: string[]
  firstHeld: number | null
  heldChanges?: ChangeItem[]
  coverageComplete?: boolean
}
type CachedManifestPage = ManifestResponse &
  Pick<ManifestProgress, 'heldChanges' | 'seen' | 'recheck'>
const progressHeader = (progress: ManifestProgress) =>
  JSON.stringify({
    ...progress,
    page: undefined,
    heldChanges: undefined,
    seen: undefined,
    recheck: undefined,
  })
const progressPage = (progress: ManifestProgress, page: ManifestResponse) =>
  JSON.stringify({
    ...page,
    heldChanges: progress.heldChanges ?? [],
    seen: progress.seen,
    recheck: progress.recheck,
  })

/** Repeated scope marks describe the walk already in progress, not a new rewind. */
export async function resumesScopeRecheck(
  state: StateStore,
  recheck: ReadonlySet<string>
): Promise<boolean> {
  const progress = JSON.parse(
    (await state.getMeta?.(MANIFEST_PROGRESS)) ?? 'null'
  ) as ManifestProgress | null
  const raw = await state.getMeta?.(MANIFEST_PAGE_DATA)
  if (progress === null || raw == null) return false
  const payload = JSON.parse(raw) as CachedManifestPage
  const covered = new Set(progress.recheck ?? payload.recheck ?? [])
  return (
    progress !== null &&
    progress.scope === ((await state.getMeta?.('marked-scope')) ?? null) &&
    (progress.generation ?? null) === ((await state.getMeta?.(GENERATION_KEY)) ?? null) &&
    [...recheck].every((id) => covered.has(id))
  )
}

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
    // Preserve the observation time for review of a newly received staged file;
    // this is not its authored mtime or an inferred server commit timestamp.
    actor: { kind: 'system', id: 'manifest', name: 'manifest' },
    at: new Date().toISOString(),
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

/** A destination can be reused by another identity; retain each identity's tombstone. */
function newest(changes: ChangeItem[]): ChangeItem[] {
  return lastPerFile(changes)
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
  private inventoryComplete = false
  private heldHead: number | null = null
  private manifestHead: number | null = null
  private readonly holds: PullHolds
  private readonly refused: PullHolds
  /** Earliest event in the current page which has not finished its durable handling. */
  private pendingSeq: number | null = null
  private attemptHeld = false
  /** Every file id a manifest page or a feed page of this run named, applied or not. */
  private readonly seen = new Set<string>()
  private get heldFiles() {
    return this.holds.files
  }
  private bootstrapContext: ManifestProgress | null = null
  /** Set while the manifest is walked. */
  private walking = false
  private followedCheckpoint = false
  private latestSnapshot = false
  private stagedReplay = false
  private lastCompleted: ChangeItem | null = null
  private feedCache: {
    since: number
    items: ChangeItem[]
    head: number
    firsts: Map<string, number>
    complete: boolean
  } | null = null
  private coverage = new Map<string, number>()

  constructor(
    private readonly client: EngineClient,
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: PullOptions,
    private readonly report: PullReport
  ) {
    this.holds = new PullHolds(state)
    this.refused = new PullHolds(
      state,
      'pull-refused-progress',
      (id) => `pull-refused:${encodeURIComponent(id)}`
    )
    this.hash = opts.hash ?? sha256
    this.placer = new PullPlacer(client, fs, state, opts, this.hash)
  }

  /** Staged changes, one page's worth of work with no cursor to move. */
  async apply(changes: ChangeItem[]): Promise<void> {
    this.stagedReplay = true
    await this.refused.load()
    const cursor = await this.state.getCursor()
    await this.page(changes, async () => {
      await transact(this.state, (tx) => this.refused.persist(cursor, cursor > 0, tx))
    })
    this.syncHeld()
  }

  async run(): Promise<void> {
    await importLegacyPullHolds(this.state, this.client)
    this.reached = this.report.cursor
    this.inventoryComplete = this.report.cursor > 0
    await this.holds.load()
    await this.refused.load()
    const durable = this.holds.header
    if (durable !== null) {
      this.heldHead = durable.head
      // A rewind must still inventory; a normal restart follows the saved head.
      const first = this.holds.earliest()
      const savedCursor = first === null ? durable.head : Math.min(durable.head, first - 1)
      this.inventoryComplete = durable.inventoryComplete && this.report.cursor === savedCursor
      // Ordinary feed retries start at the published cursor. Manifest resumes
      // use their saved snapshot head inside bootstrap(), without rewalking zero.
      this.syncHeld()
      await this.client.rememberManifest?.(
        [...this.heldFiles.values()]
          .filter((change) => change.sha !== null)
          .map((change) => ({
            ...change,
            sha: change.sha!,
            size: change.size ?? 0,
            mtime: change.mtime ?? 0,
          }))
      )
    }
    const checkpoint = await this.state.getMeta?.(MANIFEST_PROGRESS)
    if (checkpoint || this.report.cursor === 0) await this.bootstrap()
    if (!this.followedCheckpoint) {
      await this.follow()
      await this.retryObligations()
      await this.save()
    }
    if (this.report.bootstrapped) await this.recheck()
    this.syncHeld()
  }

  private async retryObligations(): Promise<void> {
    // An older refusal/hold must never become a clean base beneath a newer hold
    // for the same path. Coalesce the two durable collections as one snapshot.
    const changes = [...this.heldFiles.values(), ...this.refused.files.values()].sort(
      (a, b) => a.seq - b.seq
    )
    await this.page(
      newest(lastPerFile(changes)).filter(
        (change) => !this.client.pathRefusal?.(change.path) || this.heldFiles.has(change.file_id)
      ),
      async () => {
        await this.save()
      }
    )
  }

  /**
   * The files back in scope that neither the manifest nor the feed after it named: the server
   * deleted them while they were out of scope here. The manifest is read in path order and
   * the feed from the head its first page reported, so a file moved or restored while the
   * walk ran is in the feed, and only a file that is truly gone is in neither.
   */
  private async recheck(): Promise<void> {
    for (const fileId of this.opts.recheck ?? []) {
      checkCancellation(this.opts.signal)
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
   * Until coverage is complete, reached stays zero. Each inventory checkpoint can
   * persist holds without publishing a cursor that skips the remaining inventory.
   */
  private async bootstrap(): Promise<void> {
    this.report.bootstrapped = true
    this.inventoryComplete = false
    this.reached = 0
    let cursor: string | null = null
    let head: number | null = null
    let ahead: ChangeItem[] | null = null
    this.walking = true
    try {
      const generation = (await this.state.getMeta?.(GENERATION_KEY)) ?? null
      const scope = (await this.state.getMeta?.('marked-scope')) ?? null
      const recheck = [...(this.opts.recheck ?? [])]
      let progress: ManifestProgress | null = JSON.parse(
        (await this.state.getMeta?.(MANIFEST_PROGRESS)) ?? 'null'
      ) as ManifestProgress | null
      if (progress !== null && (progress.generation ?? null) !== generation) {
        await transact(this.state, async (tx) => {
          await tx.setMeta?.(MANIFEST_PROGRESS, null)
          await tx.setMeta?.(MANIFEST_PAGE_DATA, null)
        })
        progress = null
      }
      if (progress !== null) {
        progress.page = JSON.parse(
          (await this.state.getMeta?.(MANIFEST_PAGE_DATA)) ?? 'null'
        ) as ManifestResponse
        if (progress.page === null) throw new Error('missing manifest checkpoint page')
        const payload = progress.page as CachedManifestPage
        progress.heldChanges ??= payload.heldChanges
        progress.seen ??= payload.seen ?? []
        progress.recheck ??= payload.recheck ?? []
        if (progress.firstHeld !== null && !Array.isArray(progress.heldChanges)) progress = null
      }
      if (progress !== null) {
        await this.client.rememberManifest?.([
          ...progress.page.items,
          ...(progress.heldChanges ?? [])
            .filter((change) => change.sha !== null)
            .map((change) => ({
              ...change,
              sha: change.sha!,
              size: change.size ?? 0,
              mtime: change.mtime ?? 0,
            })),
        ])
        this.syncHeld()
        for (const id of progress.seen) this.seen.add(id)
        if (progress.coverageComplete) {
          this.bootstrapContext = progress
          // Manifest coverage is complete: guarded deletes may only be noted
          // during inventory, never while following or retrying feed changes.
          this.walking = false
          this.inventoryComplete = true
          // Newer feed events can settle an old hold, but a changed ledger base
          // alone cannot prove that the held remote version was applied.
          this.reached = progress.head
          await this.follow()
          this.followedCheckpoint = true
          await this.retryObligations()
          await this.save()
          return
        }
      }
      do {
        checkCancellation(this.opts.signal)
        const page: ManifestResponse =
          progress?.page ?? (await this.client.manifest(cursor, MANIFEST_PAGE))
        head ??= progress?.head ?? page.head_seq
        this.manifestHead = head
        progress ??= {
          page,
          head,
          generation,
          scope,
          recheck,
          completed: [],
          seen: [],
          firstHeld: this.firstHeld,
          heldChanges: [],
        }
        const checkpoint = progress
        this.bootstrapContext = checkpoint
        const saveProgress = (tx: StateStore) => {
          checkpoint.firstHeld = null
          return tx.setMeta?.(MANIFEST_PROGRESS, progressHeader(checkpoint))
        }
        await transact(this.state, async (tx) => {
          await tx.setMeta?.(MANIFEST_PAGE_DATA, progressPage(checkpoint, page))
          await saveProgress(tx)
          await this.persist(tx)
        })
        // Retain the snapshot boundary before awaiting the tail. A crash followed
        // by a rewind must not turn later feed changes into initial-inventory notes.
        if (ahead === null) {
          const tail = await this.readFeed(head)
          this.feedCache = { since: head, ...tail }
          ahead = tail.items
        }
        const laterFiles = new Set(ahead.map((change) => change.file_id))
        const completed = new Set(checkpoint.completed)
        const pending = page.items.map(asCreate)
        for (const item of page.items) this.seen.add(item.file_id)
        // Only the manifest's own head is known when the cached tail is empty.
        // A later feed page must not acknowledge an intermediate offline edit.
        this.latestSnapshot = this.feedCache?.complete === true && ahead.length === 0
        await this.page(
          pending.filter((item) => !completed.has(item.file_id) && !laterFiles.has(item.file_id)),
          async (change) => {
            if (this.heldFiles.get(change.file_id) !== change) {
              checkpoint.completed.push(change.file_id)
            }
            await transact(this.state, async (tx) => {
              await saveProgress(tx)
              await this.persist(tx)
            })
          }
        )
        checkpoint.heldChanges = []
        checkpoint.seen = [...this.seen].filter((id) => this.opts.recheck?.has(id))
        await transact(this.state, async (tx) => {
          await tx.setMeta?.(MANIFEST_PAGE_DATA, progressPage(checkpoint, page))
          await saveProgress(tx)
          await this.persist(tx)
        })
        cursor = page.next
        if (cursor !== null) {
          checkCancellation(this.opts.signal)
          const next = await this.client.manifest(cursor, MANIFEST_PAGE)
          progress = {
            page: next,
            generation,
            scope,
            recheck,
            head,
            completed: [],
            seen: checkpoint.seen,
            firstHeld: this.firstHeld,
            heldChanges: [],
          }
          await transact(this.state, async (tx) => {
            await tx.setMeta?.(MANIFEST_PAGE_DATA, progressPage(progress!, next))
            await tx.setMeta?.(MANIFEST_PROGRESS, progressHeader(progress!))
          })
        }
      } while (cursor !== null)
    } finally {
      this.walking = false
    }
    this.inventoryComplete = true
    // Re-inventorying cannot skip the feed interval where an older hold may
    // have been resolved (notably by a deletion absent from the live manifest).
    this.reached = this.heldHead !== null ? Math.min(head ?? 0, this.heldHead) : (head ?? 0)
    await this.save()
  }

  /** The feed, page after page, until the last one handed out reaches the head. */
  private async follow(): Promise<void> {
    for (;;) {
      const page =
        this.feedCache?.since === this.reached ? this.feedCache : await this.readFeed(this.reached)
      this.feedCache = null
      this.latestSnapshot = page.complete
      this.coverage = page.firsts
      await this.page(page.items, async (change) => {
        this.reached = Math.max(this.reached, change.seq)
        await this.save()
      })
      this.coverage.clear()
      this.reached = page.head
      await this.save()
      if (page.complete) return
    }
  }

  private async readFeed(since: number): Promise<{
    items: ChangeItem[]
    head: number
    firsts: Map<string, number>
    complete: boolean
  }> {
    const firsts = new Map<string, number>()
    checkCancellation(this.opts.signal)
    const page = await this.client.changes(since, CHANGES_PAGE)
    for (const change of page.items)
      firsts.set(change.file_id, Math.min(firsts.get(change.file_id) ?? change.seq, change.seq))
    const complete =
      page.next_since >= page.head_seq || (page.items.length === 0 && page.next_since <= since)
    if (!complete && page.next_since <= since) throw new Error('feed made no progress')
    return {
      items: newest([...page.items].sort((a, b) => a.seq - b.seq)),
      head: page.next_since,
      firsts,
      complete,
    }
  }

  /**
   * One page: the last change to each file, its paths checked; then the blobs those will
   * want, fetched a few at a time; and then every change in seq order. Fetching first is
   * what keeps the downloads parallel and the writes ordered. The page is taken in runs whose
   * bytes fit `prefetchBytes`, each fetched, written and let go before the next, so what is
   * held at once is bounded by bytes and not by the page's thousand files.
   */
  private async page(
    changes: ChangeItem[],
    completed?: (change: ChangeItem) => Promise<void>
  ): Promise<void> {
    this.lastCompleted = null
    try {
      await this.pageItems(changes, completed)
    } catch (error) {
      // Cancellation acknowledges the just-finished file, not the remaining page.
      // A crashed/revoked process has no signal permission to publish here.
      if (this.opts.signal?.aborted && this.lastCompleted !== null)
        await completed?.(this.lastCompleted)
      throw error
    }
  }

  private async pageItems(
    changes: ChangeItem[],
    completed?: (change: ChangeItem) => Promise<void>
  ): Promise<void> {
    checkCancellation(this.opts.signal)
    if (changes.length === 0) return
    for (const change of changes) this.seen.add(change.file_id)
    const latest = lastPerFile(changes)
    this.report.skipped += changes.length - latest.length
    const wanted = latest.filter((change) => this.acceptable(change)).sort((a, b) => a.seq - b.seq)
    if (wanted.length === 0) return
    // Every completion path shares this barrier, including staging and refusal.
    // Out-of-order preparation may persist work, but cannot publish past earlier work.
    const pending = new Set(wanted.map((change) => change.file_id))
    const ordered = [...wanted].sort(
      (a, b) => (this.coverage.get(a.file_id) ?? a.seq) - (this.coverage.get(b.file_id) ?? b.seq)
    )
    let next = 0
    const firstSequence = () =>
      ordered[next] === undefined
        ? null
        : (this.coverage.get(ordered[next]!.file_id) ?? ordered[next]!.seq)
    this.pendingSeq = firstSequence()
    const finish = async (change: ChangeItem) => {
      pending.delete(change.file_id)
      while (next < ordered.length && !pending.has(ordered[next]!.file_id)) next++
      this.pendingSeq = firstSequence()
      this.lastCompleted = change
      // Clean writes already have a durable ledger entry. A crash may replay
      // this cached page, but skips those versions without another download.
      // Holds/refusals are not inferable from the ledger: acknowledge them now.
      if (this.holds.dirty || this.refused.dirty) await completed?.(change)
    }
    // Staged before anything is fetched: a staged change wants no bytes yet.
    const taking: ChangeItem[] = []
    const staged: Staged[] = []
    const destinations = new Map(wanted.filter((c) => c.op !== 'delete').map((c) => [c.path, c]))
    for (const change of wanted) {
      checkCancellation(this.opts.signal)
      if (this.opts.retries && !this.opts.retries.ready(change.path, 'pull')) {
        this.hold(change)
        await finish(change)
        continue
      }
      // Retain the identity as an obligation until the later occupant is actually
      // installed. Do not install an obsolete occupant (or adopt its local edit).
      const occupant = destinations.get(change.path)
      if (change.op !== 'delete' && occupant && occupant.seq > change.seq) {
        this.hold(change)
        await finish(change)
        continue
      }
      const refusal = this.client.pathRefusal?.(change.path)
      if (refusal) {
        ;(this.report.rejected ??= []).push({
          change,
          code: refusal.code,
          message: refusal.message,
        })
        this.report.skipped++
        if (this.state.getMeta && this.state.setMeta) {
          this.refused.put({
            change,
            base: (await this.state.byFileId(change.file_id))?.versionId ?? null,
            firstSeq: this.coverage.get(change.file_id) ?? change.seq,
          })
          this.holds.resolve(change)
        } else {
          // Legacy stores cannot retain an inbox: leave the feed cursor before it.
          this.hold(change)
        }
        await finish(change)
        continue
      }
      try {
        const stage = await this.staging(change)
        if (stage === null) taking.push(change)
        else staged.push(stage)
      } catch (error) {
        if (!(await this.retryFailure(change, error))) throw error
        await finish(change)
      }
    }
    await this.stageAll(staged)
    for (const { change } of staged) {
      this.resolve(change)
      await finish(change)
    }
    if (taking.length === 0) {
      this.firstHeld = this.holds.earliest()
      return
    }
    const local = await shaIndex(this.state)
    const budget = this.opts.prefetchBytes ?? DEFAULT_PREFETCH_BYTES
    for (const run of runsWithin(taking, downloads, budget)) {
      checkCancellation(this.opts.signal)
      const fetched = await this.prefetch(run, local)
      for (const change of run) {
        checkCancellation(this.opts.signal)
        // Keep the durable obligation until this attempt has actually resolved it.
        this.attemptHeld = false
        const base = (await this.state.byFileId(change.file_id))?.versionId ?? null
        if (this.opts.retries && !this.opts.retries.ready(change.path, 'pull')) this.hold(change)
        else
          try {
            await this.take(change, fetched, local)
            await this.opts.retries?.succeeded(change.path, 'pull')
          } catch (error) {
            if (!(await this.retryFailure(change, error))) throw error
          }
        if (this.attemptHeld) this.holds.setBase(change.file_id, base)
        else this.resolve(change)
        await finish(change)
      }
    }
    this.firstHeld = this.holds.earliest()
  }

  private async retryFailure(change: ChangeItem, error: unknown): Promise<boolean> {
    checkCancellation(this.opts.signal)
    if (!this.opts.retries || !isFileFailure(error)) return false
    await this.opts.retries.failed(change.path, 'pull', error)
    this.hold(change)
    return true
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
    return (await fingerprintFile(this.fs, change.path, this.hash)).sha === change.sha
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
   * Called only inside a state transaction: the hold record and cursor commit together.
   */
  private async persist(tx: StateStore): Promise<void> {
    this.firstHeld = this.holds.earliest()
    this.report.cursor = Math.min(
      this.reached,
      this.firstHeld === null ? this.reached : this.firstHeld - 1,
      this.pendingSeq === null ? this.reached : this.pendingSeq - 1
    )
    await this.holds.persist(
      this.walking
        ? Math.min(this.manifestHead ?? this.reached, this.heldHead ?? Infinity)
        : this.coveredHead,
      this.inventoryComplete,
      tx
    )
    await this.refused.persist(this.coveredHead, this.inventoryComplete, tx)
    await tx.setCursor(this.report.cursor)
  }

  /** A checkpoint is another resume position: it cannot skip unrepresented work
   * any more than the public cursor can. Durable holds may lie below this head. */
  private get coveredHead(): number {
    return Math.min(this.reached, this.pendingSeq === null ? this.reached : this.pendingSeq - 1)
  }

  private async save(): Promise<void> {
    await transact(this.state, async (tx) => {
      await this.persist(tx)
      if (!this.report.bootstrapped || this.walking) return
      if (this.heldFiles.size && this.bootstrapContext !== null) {
        const progress = this.bootstrapContext
        Object.assign(progress, {
          head: this.coveredHead,
          firstHeld: null,
          completed: [],
          heldChanges: [],
          coverageComplete: true,
        })
        progress.seen = progress.recheck.filter((id) => this.seen.has(id))
        await tx.setMeta?.(MANIFEST_PROGRESS, progressHeader(progress))
        await tx.setMeta?.(
          MANIFEST_PAGE_DATA,
          progressPage(progress, { items: [], next: null, head_seq: this.coveredHead })
        )
      } else {
        await tx.setMeta?.(MANIFEST_PROGRESS, null)
        await tx.setMeta?.(MANIFEST_PAGE_DATA, null)
      }
    })
  }

  private resolve(change: ChangeItem): void {
    this.holds.resolve(change)
    this.refused.resolve(change)
    this.holds.resolvePath(change)
    this.refused.resolvePath(change)
  }

  /* ── One change ──────────────────────────────────────────────────────── */

  private async take(
    change: ChangeItem,
    fetched: Map<string, Uint8Array>,
    local: Map<string, StateEntry>
  ): Promise<void> {
    const entry = await this.state.byFileId(change.file_id)
    if (await olderPull(this.state, change, entry)) {
      this.report.skipped++
      return
    }
    await this.placer.pending.superseded(change)
    if (this.stagedReplay && change.op !== 'delete') {
      let target: string
      try {
        target = await this.placer.targetOf(change, entry)
      } catch (error) {
        if (!(error instanceof AbeleError && error.code === 'path_taken')) throw error
        this.hold(change)
        return
      }
      if (
        !replayAuthority(
          change.file_id,
          entry,
          entry,
          await pathOccupant(this.fs, this.state, target, change.file_id)
        )
      ) {
        this.hold(change)
        return
      }
    }
    if (this.passedOver(change)) {
      await this.passOver(change, entry)
      return
    }
    // Already here: a change re-read on the way back to the head, or one this device made.
    if (
      change.op !== 'delete' &&
      change.sha !== null &&
      entry?.versionId === change.version_id &&
      !(this.opts.recheck?.has(entry.fileId) && (await this.fs.stat(entry.path)) === null)
    ) {
      await this.placer.settled(change)
      this.report.skipped++
      return
    }
    // A recorded installation can settle even on an intermediate page. Check
    // its provenance before treating equal untracked bytes as an offline edit.
    if (await this.placer.adopt(change, entry)) {
      this.report.applied++
      return
    }
    const adoption = await this.placer.adoptExisting(change, entry, this.latestSnapshot)
    if (adoption === 'held') {
      // An untracked equal file may be an offline edit. Only the actual head can
      // acknowledge it; an intermediate page cannot establish its clean base.
      this.hold(change)
      return
    }
    if (adoption) {
      this.report.applied++
      return
    }
    if (touchesDeferred(this.opts.defer, change.path, change.prev_path, entry?.wirePath)) {
      // The equality probe above permits metadata adoption only, never a later disk write.
      await this.stageAll([stageFrom(change, entry)])
      return
    }
    if (this.isDirty(change, entry)) {
      if (await this.goneBoth(change, entry)) return
      if (this.walking && !this.heldFiles.has(change.file_id) && this.isNoted(change, entry))
        this.note(change)
      else this.hold(change)
      return
    }

    if (
      this.opts.protectMissing &&
      entry !== null &&
      change.sha !== null &&
      change.op !== 'delete' &&
      !this.opts.recheck?.has(entry.fileId) &&
      (await this.fs.stat(entry.path)) === null &&
      (await this.placer.pending.matching(change, entry)) === null
    ) {
      this.hold(change)
      return
    }
    if (change.op === 'delete' || change.sha === null) {
      // A delete of a file this device never had is nothing to do, not something done.
      if (entry === null) this.report.skipped++
      else if (await this.placer.edited(entry)) this.hold(change)
      else if (await this.placer.drop(entry, change)) this.report.applied++
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
    if (deferredSource(this.opts.defer, change, entry)) {
      await this.stageAll([stageFrom(change, entry)])
      return
    }
    // Exclusion also ends an ordinary held pull, which has no deferred record
    // for Staging.tidy to drop. Keep only a still-deferred source's decision.
    await this.placer.pending.discardHeld(change)
    // A move the entry already stands at is this device's own coming back — a copy kept here
    // under a head over the cap, moved here — not a file leaving the synced set.
    if (entry === null || entry.wirePath === change.path) {
      this.report.skipped++
      return
    }
    // Not over a local edit, though: that is the engine's to push and settle first.
    if (this.isDirty(change, entry) || (await this.placer.edited(entry))) {
      this.hold(change)
      return
    }
    if (await this.placer.drop(entry, change)) this.report.applied++
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
    await transact(this.state, async (tx) => {
      await tx.delete(entry.path)
      await recordPull(tx, change, true)
    })
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
    this.attemptHeld = true
    this.holds.put({
      change,
      base: this.holds.records.get(change.file_id)?.base ?? null,
      firstSeq: this.coverage.get(change.file_id) ?? change.seq,
    })
    this.firstHeld = this.holds.earliest()
    this.opts.log?.(`pull: holding ${change.op} of ${change.path} at ${change.seq}`)
  }
  private syncHeld(): void {
    this.report.held = [...this.heldFiles.values()]
    this.firstHeld = this.holds.earliest()
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
    const wanted = new Map<string, ChangeItem>()
    const seen = new Set<string>()
    for (const change of changes) {
      checkCancellation(this.opts.signal)
      try {
        const sha = change.sha
        if (sha === null || change.op === 'delete') continue
        if (this.fs.beginAtomicWrite && this.fs.reopenStage && this.client.openVersion) continue
        if (seen.has(sha) || local.has(sha)) continue
        if (this.passedOver(change)) continue
        const entry = await this.state.byFileId(change.file_id)
        if (entry?.versionId === change.version_id || entry?.sha === sha) continue
        if (this.isDirty(change, entry)) continue
        if (entry !== null && (await this.placer.edited(entry))) continue
        if (
          entry !== null &&
          this.opts.protectMissing &&
          !this.opts.recheck?.has(entry.fileId) &&
          (await this.fs.stat(entry.path)) === null
        )
          continue
        // Something on disk that nothing has synced: a device syncing over a copy of the vault
        // it was handed, or somebody's unsynced work. The apply adopts the first and holds the
        // second, and wants no bytes from the server for either.
        let target: string
        try {
          target = await this.placer.targetOf(change, entry)
        } catch (error) {
          // A known collision is held by take(); it needs no content prefetch.
          if (error instanceof AbeleError && error.code === 'path_taken') continue
          if (
            error instanceof EngineError &&
            error.code === 'conflict' &&
            error.cause === undefined
          )
            continue
          throw error
        }
        if ((await this.fs.stat(target)) !== null) {
          if ((await pathOccupant(this.fs, this.state, target, change.file_id)) === null) continue
          if (await this.placer.matchesTarget(change, entry)) continue
        }
        seen.add(sha)
        wanted.set(sha, change)
      } catch (error) {
        if (!(await this.retryFailure(change, error))) throw error
      }
    }

    const fetched = new Map<string, Uint8Array>()
    await pool([...wanted], this.opts.concurrency ?? DEFAULT_CONCURRENCY, async ([sha, change]) => {
      checkCancellation(this.opts.signal)
      // A resumed manifest page already names immutable versions. A fresh token client
      // must not rediscover their SHA-to-version mapping by walking the manifest from 0.
      let bytes: Uint8Array | null
      try {
        bytes = await fetchChecked(
          {
            getBlob: () =>
              this.client.readEffects && this.client.versionBytes
                ? this.client.versionBytes(change.file_id, change.version_id, this.opts.signal)
                : this.client.getBlob(sha, this.opts.signal),
          },
          sha,
          this.hash
        )
      } catch (error) {
        checkCancellation(this.opts.signal)
        // A local copy may have arrived while the content request was in flight.
        // Refresh spelling inventory as well as bytes; a cached absence is stale.
        if (
          await this.placer.matchesTarget(change, await this.state.byFileId(change.file_id), true)
        )
          return
        if (await this.retryFailure(change, error)) return
        throw error
      }
      if (bytes === null) this.placer.disbelieve(sha)
      else fetched.set(sha, bytes)
    })
    return fetched
  }
}
