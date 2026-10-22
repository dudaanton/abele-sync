import { transact } from './stateTransaction.js'
import { AbeleError, caseKey, normalisePath, type ChangeItem } from '@abele/sync-protocol'
import { notifyApplied } from './applied.js'
import { bytesFor, settledStat } from './apply.js'
import type { EngineClient } from './engineClient.js'
import { EngineError } from './errors.js'
import type { FileInfo, FileSystem, ConditionalFileOperation } from './fs.js'
import { fingerprintFile } from './fs.js'
import { downloadToStage, TransferBudget, type ChunkSource } from './streaming.js'
import type { PullOptions } from './puller.js'
import { PendingPullWrites } from './pullWrite.js'
import type { StateEntry, StateStore } from './state.js'
import { LocalPaths, resolveLocalFile } from './localPaths.js'
import { checkCancellation } from './cancellation.js'
import { discardPullStage, stageMissing } from './pullStages.js'
import { evictionKey } from './pullEvictions.js'
import { scanHintKey } from './scanHints.js'

/**
 * A change put onto this disk: its file carried to where the change says, its bytes written or
 * found already there, and what is then on the disk recorded. Whatever stands in the way — a
 * local edit, a file nothing synced, something that is not a file — is said, and the change held.
 */

/**
 * What the target of a change turned out to be: free to write, held, or already the bytes —
 * with the stat those bytes were hashed under, which is what adopting the file records.
 */
type Target = { free: FileInfo | null; removed?: true } | 'held' | 'aside' | { have: FileInfo }

const sameStat = (a: FileInfo | null, b: FileInfo | null): boolean =>
  a === null || b === null ? a === b : a.size === b.size && a.mtime === b.mtime

/** The disk half of one pull: the adapters and the options it runs over. */
export class PullPlacer {
  private readonly budget: TransferBudget
  /** Shas the server answered with bytes that do not hash to them; nothing of theirs is written. */
  readonly lying = new Set<string>()
  readonly pending: PendingPullWrites
  private readonly paths: (path: string) => Promise<LocalPaths>

  constructor(
    private readonly client: Pick<EngineClient, 'getBlob' | 'openVersion'>,
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: Pick<
      PullOptions,
      | 'signal'
      | 'dirty'
      | 'expected'
      | 'filter'
      | 'onAside'
      | 'log'
      | 'preserveMissing'
      | 'transferBudget'
      | 'onApplied'
    >,
    private readonly hash: (bytes: Uint8Array) => Promise<string>
  ) {
    this.pending = new PendingPullWrites(state)
    this.paths = LocalPaths.filePass(fs, state)
    this.budget = opts.transferBudget ?? new TransferBudget()
  }

  /**
   * Whether a synced file holds an edit nobody has pushed, by the test the pusher uses to
   * call a file touched: its size or mtime no longer match its entry. The engine's `dirty`
   * set says the same from what the watcher reported; this asks the file itself, for the
   * edit made before a watcher was listening or on a host that has none. A file that is
   * gone is a delete the normal scan will send. Staged approval marks tracked sources whose
   * absence must instead hold the write, even in a fresh engine with no watcher history.
   *
   * The bytes the change carries do not enter into it. A move of the very bytes the file was
   * synced with would still carry the edited file across and then, finding its stat changed,
   * write the synced bytes over the edit — and record the disk as it then is, so no scan would
   * ever send the edit. A touch that changed no bytes is held once: the scan hashes it, the
   * push repairs the entry's mtime, and the pull after that writes through.
   */
  async edited(entry: StateEntry, target = entry.path): Promise<boolean> {
    let path = entry.path
    let have = await this.fs.stat(path)
    // A missing source can be an offline rename. Its untracked destination must
    // prove the old base, not merely equality with an intermediate remote version.
    if (have === null && target !== path) {
      path = target
      have = await this.fs.stat(path)
    }
    if (have === null) return this.opts.preserveMissing?.has(entry.fileId) ?? false
    if (have.size !== entry.size || have.mtime !== entry.mtime) return true
    // Metadata can be preserved by an editor (or rounded by a filesystem).
    // Never overwrite a target on that evidence alone.
    return (await fingerprintFile(this.fs, path, this.hash)).sha !== entry.sha
  }
  async settled(change: ChangeItem): Promise<void> {
    const receipt = await this.pending.receiptId(change)
    if (receipt !== undefined) await this.fs.discardInstallation?.(receipt)
    await this.pending.settled(change, (id) => discardPullStage(this.fs, id))
  }

  /**
   * Recover only a write this pull recorded before touching the disk. Content equality alone
   * can be an offline edit matching an intermediate feed version, not a completed pull.
   * The intent must name this exact version and the still-current pre-write ledger entry,
   * and the host must prove publication by stage/receipt identity, never matching bytes alone.
   */
  async adopt(change: ChangeItem, entry: StateEntry | null): Promise<boolean> {
    if (change.op === 'delete' || change.sha === null) return false
    if ((await this.paths(change.path)).blocked(change.path)) return false
    const pending = await this.pending.matching(change, entry)
    if (pending === null) return false
    try {
      const resolved = await resolveLocalFile(this.fs, this.state, change.path, pending.target)
      if (resolved !== pending.target) return false
    } catch (error) {
      if (!this.inTheWay(error) && !(error instanceof AbeleError && error.code === 'path_taken'))
        throw error
      return false
    }
    const notWritten = async (): Promise<false> => {
      if (pending.stageId !== undefined) return false
      // Once the planned result is absent or edited, the intent cannot authorize a later save.
      await this.pending.clear(change.file_id)
      return false
    }
    if (normalisePath(pending.target) !== change.path) return notWritten()
    const occupant = await this.state.get(pending.target)
    if (occupant !== null && occupant.fileId !== change.file_id) return notWritten()
    // A moved source recreated since the crash belongs to the user; do not remove it.
    if (pending.from !== null && (await this.fs.stat(pending.from)) !== null) return notWritten()
    const have = await this.fs.stat(pending.target)
    if (have === null) return notWritten()
    let installed = false
    try {
      installed =
        (pending.receiptId !== undefined
          ? await this.fs.installedFile?.(pending.receiptId, pending.target, change.sha)
          : pending.stageId !== undefined
            ? await (await this.fs.reopenStage?.(pending.stageId))?.installed?.()
            : false) === true
    } catch (error) {
      if (!stageMissing(error)) throw error
    }
    // A failed read is not evidence that this installation did not happen.
    // Keep the exact intent/receipt so a later recovery can retry verification.
    const sha = (await fingerprintFile(this.fs, pending.target, this.hash)).sha
    // The rename landed, but the following write did not. Keep its exact intent so
    // recovery can replace only the proven old base at the new target.
    if (sha !== change.sha && pending.from !== null && pending.base?.sha === sha) return false
    if (sha !== change.sha || have.size !== change.size) return notWritten()
    if (!installed) return notWritten()
    if (!sameStat(have, await this.fs.stat(pending.target))) return notWritten()
    await this.remember(change, change.sha, pending.target, have, pending.from)
    return true
  }

  /** A deferred path may adopt bytes already present, but never mutate the filesystem. */
  async adoptExisting(change: ChangeItem, entry: StateEntry | null): Promise<boolean> {
    if (change.op === 'delete' || change.sha === null) return false
    // Equal remote bytes can be an offline edit matching an intermediate version.
    // Only proven installation of an exact pending write can adopt over an edited base.
    let target: string
    try {
      target = await resolveLocalFile(
        this.fs,
        this.state,
        change.path,
        entry?.wirePath === change.path ? entry.path : undefined
      )
    } catch (error) {
      if (!this.inTheWay(error) && !(error instanceof AbeleError && error.code === 'path_taken'))
        throw error
      return false
    }
    const pending = await this.pending.matching(change, entry)
    if (pending !== null && pending.target !== target) return false
    if (entry !== null && (await this.edited(entry, target))) return false
    const from = entry === null || entry.path === target ? null : entry.path
    if (from !== null && (await this.fs.stat(from)) !== null) return false
    const before = await this.fs.stat(target)
    if (before === null) return false
    const occupant = await this.state.get(target)
    if (occupant !== null && occupant.fileId !== entry?.fileId && (await this.edited(occupant)))
      return false
    const sha = (await fingerprintFile(this.fs, target, this.hash)).sha
    if (
      sha !== change.sha ||
      (entry !== null && sha !== entry.sha) ||
      (occupant !== null && sha !== occupant.sha) ||
      (await this.unclassified(target, sha))
    )
      return false
    if (!sameStat(before, await this.fs.stat(target))) return false
    await this.remember(change, change.sha, target, before, from)
    return true
  }

  /** Resolve the physical spelling before considering a content request. */
  async targetOf(change: ChangeItem, entry: StateEntry | null, fresh = false): Promise<string> {
    return resolveLocalFile(
      this.fs,
      this.state,
      change.path,
      entry?.wirePath === change.path ? entry.path : undefined,
      fresh ? undefined : await this.paths(change.path)
    )
  }

  /** Equality of actual target bytes makes a prefetch unnecessary regardless of ledger age. */
  async matchesTarget(
    change: ChangeItem,
    entry: StateEntry | null,
    fresh = false
  ): Promise<boolean> {
    if (change.sha === null || change.op === 'delete') return false
    try {
      const target = await this.targetOf(change, entry, fresh)
      const before = await this.fs.stat(target)
      return (
        before !== null &&
        (await fingerprintFile(this.fs, target, this.hash)).sha === change.sha &&
        sameStat(before, await this.fs.stat(target))
      )
    } catch {
      return false
    }
  }

  /**
   * The file is gone from the vault, so it goes from the disk and from the state. False when
   * the disk would not let go of it — a folder or a link has taken the name — and the change
   * is held for a later pull, rather than the whole sync failing on it every time.
   */
  async drop(entry: StateEntry): Promise<boolean> {
    if ((await LocalPaths.forFile(this.fs, entry.wirePath, this.state)).blocked(entry.wirePath))
      return false
    if (!(await this.clearPath(entry.path, entry))) return false
    this.opts.expected.clear(entry.path)
    await transact(this.state, async (tx) => {
      await tx.delete(entry.path)
      await tx.setMeta?.(scanHintKey(entry.path), null)
      await new PendingPullWrites(tx).clear(entry.fileId)
    })
    await notifyApplied(this.opts, {
      path: entry.wirePath,
      kind: 'delete',
      origin: 'remote',
      fileId: entry.fileId,
    })
    return true
  }

  /** `remove`, with something in the way reported rather than thrown. */
  private async effect(op: ConditionalFileOperation): Promise<boolean> {
    // A new save at a formerly absent name must not become a clean pull base
    // on retry before scanning classifies it.
    await this.state.setMeta?.(`pull-base:${op.path}`, JSON.stringify({ base: op.expected }))
    return (await this.fs.conditionalFile?.(op)) ?? false
  }

  private async unclassified(path: string, sha: string): Promise<boolean> {
    if (await this.state.get(path)) return false
    const raw = await this.state.getMeta?.(`pull-base:${path}`)
    if (!raw) return false
    const saved = JSON.parse(raw) as { base: { sha: string } | null }
    return saved.base === null || saved.base.sha !== sha
  }

  private async clearPath(path: string, base: StateEntry): Promise<boolean> {
    try {
      return await this.effect({ path, expected: base, effect: { kind: 'remove' } })
    } catch (error) {
      if (!this.inTheWay(error)) throw error
      this.opts.log?.(`pull: ${path} cannot be removed: ${(error as Error).message}`)
      return false
    }
  }

  /** A disk saying something that is not a file holds the path: the adapter's `conflict`. */
  private inTheWay(error: unknown): boolean {
    return error instanceof EngineError && error.code === 'conflict' && error.cause === undefined
  }

  /**
   * Put the file where the change says it is, with the bytes it says it holds. Everything
   * that leaves a file behind comes through here — a create, a modify, a merge, a restore,
   * a conflict copy and a move alike — because they differ only in where the bytes come
   * from and whether the file has to be carried there first.
   *
   * Answers false when the target is someone's unpushed work, when the server's bytes are
   * not what it says they are, or when the disk has something other than a file in the way:
   * the change is held instead. Answers `aside` when the target is a file this device does
   * not sync — over its cap — and nothing has synced: it is left alone, and so is the change.
   */
  async place(
    change: ChangeItem,
    sha: string,
    entry: StateEntry | null,
    fetched: Map<string, Uint8Array>,
    local: Map<string, StateEntry>
  ): Promise<boolean | 'aside'> {
    // The spelling on disk: the entry's own where it is the same path — an NFD disk keeps
    // its own decomposition of an NFC wire path — and the wire's otherwise. Case is part of
    // the path here, not folded away: a server-side rename of `Note.md` to `note.md` is a
    // rename, and a device that kept its old spelling would push it straight back.
    let target: string
    try {
      target = await resolveLocalFile(
        this.fs,
        this.state,
        change.path,
        entry?.wirePath === change.path ? entry.path : undefined,
        await this.paths(change.path)
      )
    } catch (error) {
      if (!this.inTheWay(error) && !(error instanceof AbeleError && error.code === 'path_taken'))
        throw error
      this.opts.log?.(`pull: held ${change.path}: ${(error as Error).message}`)
      return false
    }
    const from = entry === null || entry.path === target ? null : entry.path

    // The first snapshot precedes the decision. A file created or edited during clear()
    // must not become the new baseline merely because the download has not begun yet.
    const firstTarget = await this.fs.stat(target)
    const beforeFrom = from === null ? null : await this.fs.stat(from)
    // A durable stage is authorized by this exact version and unchanged ledger base.
    // Recover it before ordinary clearance: a crash may already have moved the old name.
    const pending = await this.pending.matching(change, entry)
    if (pending && pending.target !== target) {
      this.opts.log?.(
        `pull: held ${change.path}: pending physical write path changed; review required`
      )
      return false
    }
    if (pending?.stageId && this.fs.reopenStage && this.client.openVersion) {
      if (pending.target !== target || pending.from !== from) return false
      const occupant = await this.state.get(target)
      if (occupant && occupant.fileId !== change.file_id) return false
      if (
        from !== null &&
        beforeFrom !== null &&
        firstTarget !== null &&
        caseKey(from) !== caseKey(target)
      )
        return false
      return this.streamPlace(change, sha, entry, target, from, firstTarget, beforeFrom, local)
    }
    if (entry !== null && (await this.edited(entry, target))) return false
    const movedBase =
      pending !== null &&
      !pending.stageId &&
      entry !== null &&
      from !== null &&
      pending.from === from &&
      beforeFrom === null &&
      firstTarget !== null &&
      (await fingerprintFile(this.fs, target, this.hash)).sha === entry.sha &&
      sameStat(firstTarget, await this.fs.stat(target))
    const state = movedBase
      ? { free: firstTarget }
      : await this.clear(target, from, change, sha, firstTarget)
    if (state === 'held') return false
    if (state === 'aside') {
      this.opts.log?.(
        `pull: passing over ${change.path}: the file here is one this device does not sync`
      )
      await this.opts.onAside?.(target, change.path)
      return 'aside'
    }

    if (typeof state === 'object' && 'have' in state) {
      // An unsynced local file at the target already holds these bytes — a device syncing
      // over a copy of the vault it was given. Adopt it rather than write it again, as it
      // lies: its own size and mtime, the stat its bytes were just hashed under, so filing it
      // does not read and hash it a second time.
      if (from !== null) {
        if (entry === null || !(await this.clearPath(from, entry))) return false
      }
      await this.remember(change, sha, target, state.have, from)
      return true
    }

    // The bytes before anything on the disk moves: a server whose blob is not what it says
    // leaves the file where it was, and the change is held with the reason in the log.
    const beforeTarget = state.free
    await this.state.setMeta?.(`pull-base:${target}`, JSON.stringify({ base: entry }))
    if (!state.removed && !sameStat(firstTarget, beforeTarget)) return false
    if (
      this.fs.beginAtomicWrite &&
      this.fs.reopenStage &&
      this.client.openVersion &&
      change.size !== null
    ) {
      return this.streamPlace(change, sha, entry, target, from, beforeTarget, beforeFrom, local)
    }
    let bytes: Uint8Array | null = null
    if (entry === null || entry.sha !== sha || (firstTarget === null && beforeFrom === null)) {
      bytes = await this.bytesOf(sha, fetched, local)
      if (bytes === null) return false
    }
    if (!sameStat(beforeTarget, await this.fs.stat(target))) return false
    if (from !== null && !sameStat(beforeFrom, await this.fs.stat(from))) return false
    // Even a same-size, same-mtime write while the download was in flight is local work.
    if (entry !== null && (await this.edited(entry, target))) return false

    // What the file will be once this is done: as it was, or exactly what gets written.
    let wrote: { size: number; mtime: number }
    checkCancellation(this.opts.signal)
    try {
      if (from !== null && (await this.fs.stat(from)) !== null) {
        await this.pending.prepare(change, entry, target, from)
        if (
          !sameStat(beforeFrom, await this.fs.stat(from)) ||
          !sameStat(beforeTarget, await this.fs.stat(target)) ||
          (entry !== null && (await this.edited(entry, target)))
        ) {
          await this.pending.clear(change.file_id)
          return false
        }
        if (
          entry === null ||
          !(await this.effect({
            path: from,
            expected: entry,
            effect: { kind: 'move', to: target },
          }))
        )
          return false
      }
      // A host move can yield while an editor saves at the destination, including
      // when the remote version carries the old bytes and no replacement is planned.
      if (entry !== null && (await this.edited(entry, target))) {
        await this.pending.clear(change.file_id)
        return false
      }
      const have = await this.fs.stat(target)
      const current =
        entry !== null &&
        entry.sha === sha &&
        have !== null &&
        have.size === entry.size &&
        have.mtime === entry.mtime
      if (current) {
        wrote = { size: entry.size, mtime: entry.mtime }
      } else {
        bytes ??= await this.bytesOf(sha, fetched, local)
        if (bytes === null) return false
        // The fallback above can await a download too, after a move. A newly
        // created or edited target belongs to the user, not to this old plan.
        if (from === null) await this.pending.prepare(change, entry, target, from)
        // Saving intent is awaited too; a local edit made during it is not ours to overwrite.
        if (
          !sameStat(have, await this.fs.stat(target)) ||
          (entry !== null && (await this.edited(entry, target)))
        ) {
          await this.pending.clear(change.file_id)
          return false
        }
        await this.recheckTarget(change.path, target)
        const receipt = crypto.randomUUID()
        await this.pending.prepare(change, entry, target, from, undefined, receipt)
        this.opts.expected.expect(target, sha)
        if (
          !(await this.effect({
            path: target,
            expected:
              have === null ? null : { size: have.size, mtime: have.mtime, sha: entry?.sha ?? sha },
            effect: { kind: 'write', bytes, mtime: change.mtime ?? 0, receipt },
          }))
        ) {
          this.opts.expected.clear(target)
          return false
        }
        wrote = { size: bytes.length, mtime: change.mtime ?? 0 }
      }
    } catch (error) {
      // Operational failure can follow installation (for example its durability
      // barrier). Preserve intent/evidence until recovery establishes the outcome.
      this.opts.expected.clear(target)
      if (!this.inTheWay(error)) throw error
      await this.pending.clear(change.file_id)
      this.opts.log?.(`pull: ${target} cannot be written: ${(error as Error).message}`)
      return false
    }
    await this.remember(change, sha, target, wrote, from)
    return true
  }

  private async streamPlace(
    change: ChangeItem,
    sha: string,
    entry: StateEntry | null,
    target: string,
    from: string | null,
    beforeTarget: FileInfo | null,
    beforeFrom: FileInfo | null,
    local: Map<string, StateEntry>
  ): Promise<boolean> {
    const identity = { sha, size: change.size! }
    const pending = await this.pending.matching(change, entry)
    // Persist authority from the ledger, never a fresh read that could already
    // contain an edit made after our inspection and before stage allocation.
    const base =
      entry !== null && (beforeTarget !== null || beforeFrom !== null)
        ? { sha: entry.sha, size: entry.size, mtime: entry.mtime }
        : null
    await this.state.setMeta?.(`pull-base:${target}`, JSON.stringify({ base }))
    if (!pending?.stageId) await this.pending.prepare(change, entry, target, from)
    const stage =
      pending?.stageId !== undefined
        ? await this.fs.reopenStage!(pending.stageId)
        : await this.fs.beginAtomicWrite!(target, change.mtime ?? 0, base, (id) =>
            this.pending.prepare(change, entry, target, from, id)
          )
    if (!pending?.stageId) await this.pending.prepare(change, entry, target, from, stage.id)
    try {
      const source =
        (await this.localSource(sha, local)) ??
        (await this.client.openVersion!(
          change.file_id,
          change.version_id,
          identity,
          this.opts.signal
        ))
      await downloadToStage(source, stage, identity, this.budget, this.opts.signal, async () => {
        await this.recheckTarget(change.path, target)
        if (
          !sameStat(beforeTarget, await this.fs.stat(target)) ||
          !sameStat(beforeFrom, from === null ? null : await this.fs.stat(from)) ||
          (!pending?.stageId && entry !== null && (await this.edited(entry, target)))
        )
          throw new EngineError('conflict', 'pull target changed during transfer')
        if (
          from !== null &&
          beforeFrom !== null &&
          (entry === null ||
            !(await this.effect({
              path: from,
              expected: entry,
              effect: { kind: 'move', to: target },
            })))
        )
          throw new EngineError('conflict', 'pull source changed before move')
        this.opts.expected.expect(target, sha)
      })
      await this.remember(
        change,
        sha,
        target,
        { size: identity.size, mtime: change.mtime ?? 0 },
        from
      )
      return true
    } catch (error) {
      this.opts.expected.clear(target)
      if (!this.inTheWay(error)) throw error
      await stage.discard()
      await this.pending.clear(change.file_id)
      this.opts.log?.(`pull: holding ${target}: ${(error as Error).message}`)
      return false
    }
  }

  private async localSource(
    sha: string,
    local: Map<string, StateEntry>
  ): Promise<ChunkSource | null> {
    const entry = local.get(sha)
    if (entry === undefined) return null
    try {
      if (this.fs.openRead) {
        if ((await fingerprintFile(this.fs, entry.path, this.hash, this.opts.signal)).sha !== sha)
          return null
        return await this.fs.openRead(entry.path)
      }
      const bytes = await this.fs.read(entry.path)
      if ((await this.hash(bytes)) !== sha) return null
      return {
        size: bytes.length,
        read: async (at, length) => bytes.slice(at, at + length),
        assertUnchanged: async () => {},
        close: async () => {},
      }
    } catch {
      return null
    }
  }

  private async recheckTarget(wire: string, target: string): Promise<void> {
    try {
      if ((await resolveLocalFile(this.fs, this.state, wire, target)) === target) return
    } catch (error) {
      if (!this.inTheWay(error) && !(error instanceof AbeleError && error.code === 'path_taken'))
        throw error
      // Inventory equivalence is not permission to write through a new alias.
    }
    throw new EngineError('conflict', `normalization collision or changed parent: ${target}`)
  }

  /**
   * Make the target ready to receive the file, or say why it cannot be.
   *
   * A synced file of another id there is one the server says has moved away or gone:
   * it is dropped, unless it holds a local edit, which is the engine's to settle first.
   * A file no state entry claims is local work nobody has pushed yet, and is never
   * written over — unless it is already byte for byte what the change carries.
   */
  private async clear(
    target: string,
    from: string | null,
    change: ChangeItem,
    sha: string,
    observed: FileInfo | null
  ): Promise<Target> {
    const occupant = await this.state.get(target)
    if (occupant !== null) {
      if (occupant.fileId === change.file_id) return { free: observed }
      if (this.opts.dirty.has(occupant.wirePath) || (await this.edited(occupant))) {
        return 'held'
      }
      const intent = evictionKey(occupant.fileId)
      await this.state.setMeta?.(intent, JSON.stringify(occupant))
      if (!(await this.clearPath(occupant.path, occupant))) {
        await this.state.setMeta?.(intent, null)
        return 'held'
      }
      this.opts.expected.clear(occupant.path)
      await transact(this.state, async (tx) => {
        await tx.delete(occupant.path)
        await tx.setMeta?.(intent, null)
      })
      // Our removal authorizes only an absent target. A file saved while the ledger
      // deletion awaited belongs to the user; it must not become our new baseline.
      return { free: null, removed: true }
    }
    const there = observed
    // A case-only rename on a case-insensitive disk: what a `stat` finds at the target is the
    // very file being renamed, seen through its other spelling. Only the disk can say — on a
    // case-sensitive one those two names are two files, and the second is somebody's unsynced
    // work, which falls through below and is held rather than renamed over.
    if (from !== null && there !== null && caseKey(from) === caseKey(target)) {
      const source = await this.fs.stat(from)
      if (source !== null && source.size === there.size && source.mtime === there.mtime) {
        return { free: there }
      }
    }
    if (there === null) return { free: null }
    // A local file this device does not sync — over its cap — is neither sent nor written
    // over: held, the change would stand in the cursor's way for good.
    if (this.opts.filter.excluded(change.path, there.size)) return 'aside'
    try {
      if (await this.unclassified(target, sha)) return 'held'
      return (await fingerprintFile(this.fs, target, this.hash)).sha === sha
        ? { have: there }
        : 'held'
    } catch {
      // It was there a moment ago and cannot be read now: leave it to the next pull.
      return 'held'
    }
  }

  /**
   * Record what is now on disk. The size and mtime are the disk's own: when the bytes were
   * written they are the change's, and when the file was left where it was they are what
   * it still has — either way the next scan compares them against a `stat` and finds them.
   * Unless the disk answers with something other than `wrote` and other bytes than `sha`:
   * that is an edit that landed after the write, and `settledStat` keeps it visible.
   */
  private async remember(
    change: ChangeItem,
    sha: string,
    target: string,
    wrote: { size: number; mtime: number },
    from: string | null = null
  ): Promise<void> {
    const have = await settledStat(this.fs, target, sha, wrote, this.hash)
    const stageId = await this.pending.stageId(change)
    const receiptId = await this.pending.receiptId(change)
    await transact(this.state, async (tx) => {
      if (from !== null) await tx.delete(from)
      await tx.put({
        path: target,
        wirePath: change.path,
        fileId: change.file_id,
        versionId: change.version_id,
        sha,
        size: have.size,
        mtime: have.mtime,
      })
      await tx.setMeta?.(scanHintKey(target), null)
      await tx.setMeta?.(`pull-base:${target}`, null)
      if (from !== null) await tx.setMeta?.(scanHintKey(from), null)
      if (stageId === undefined) await new PendingPullWrites(tx).clear(change.file_id)
    })
    if (stageId !== undefined) {
      await discardPullStage(this.fs, stageId)
      await this.pending.clear(change.file_id)
    }
    if (receiptId !== undefined) await this.fs.discardInstallation?.(receiptId)
    const source = change.prev_path ?? (from === null ? undefined : from.normalize('NFC'))
    await notifyApplied(this.opts, {
      path: change.path,
      kind: source !== undefined && source !== change.path ? 'move' : 'upsert',
      ...(source !== undefined && source !== change.path ? { from: source } : {}),
      origin: 'remote',
      fileId: change.file_id,
    })
  }

  /** The bytes for a sha: prefetched, a local file that still holds them, or the server. */
  private async bytesOf(
    sha: string,
    fetched: Map<string, Uint8Array>,
    local: Map<string, StateEntry>
  ): Promise<Uint8Array | null> {
    const ready = fetched.get(sha)
    if (ready !== undefined) return ready
    if (this.lying.has(sha)) return null
    const bytes = await bytesFor(this.client, this.fs, sha, local, this.hash)
    if (bytes === null) this.disbelieve(sha)
    return bytes
  }

  /** The server answered a sha with other bytes: said once, and nothing of it written. */
  disbelieve(sha: string): void {
    if (this.lying.has(sha)) return
    this.lying.add(sha)
    this.opts.log?.(
      `pull: the server's bytes for ${sha} do not hash to it; holding what needs them`
    )
  }
}
