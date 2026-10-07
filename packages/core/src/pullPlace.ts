import { caseKey, normalisePath, type ChangeItem } from '@abele/sync-protocol'
import { bytesFor, settledStat, writeExpected } from './apply.js'
import type { VaultClient } from './client.js'
import { EngineError } from './errors.js'
import type { FileInfo, FileSystem } from './fs.js'
import type { PullOptions } from './puller.js'
import { PendingPullWrites } from './pullWrite.js'
import type { StateEntry, StateStore } from './state.js'
import { personalNoteDelivery } from './personalNoteEvents.js'

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
  /** Shas the server answered with bytes that do not hash to them; nothing of theirs is written. */
  readonly lying = new Set<string>()
  readonly pending: PendingPullWrites

  constructor(
    private readonly client: Pick<VaultClient, 'getBlob'>,
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: Pick<
      PullOptions,
      | 'dirty'
      | 'expected'
      | 'filter'
      | 'onAside'
      | 'log'
      | 'preserveMissing'
      | 'onPersonalNoteApplied'
    >,
    private readonly hash: (bytes: Uint8Array) => Promise<string>
  ) {
    this.pending = new PendingPullWrites(state)
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
  async edited(entry: StateEntry): Promise<boolean> {
    const have = await this.fs.stat(entry.path)
    if (have === null) return this.opts.preserveMissing?.has(entry.fileId) ?? false
    if (have.size !== entry.size || have.mtime !== entry.mtime) return true
    // Metadata can be preserved by an editor (or rounded by a filesystem).
    // Never overwrite a target on that evidence alone.
    try {
      return (await this.hash(await this.fs.read(entry.path))) !== entry.sha
    } catch {
      return true
    }
  }

  /**
   * Recover only a write this pull recorded before touching the disk. Content equality alone
   * can be an offline edit matching an intermediate feed version, not a completed pull.
   * The intent must name this exact version and the still-current pre-write ledger entry.
   */
  async adopt(change: ChangeItem, entry: StateEntry | null): Promise<boolean> {
    if (change.op === 'delete' || change.sha === null) return false
    const pending = await this.pending.matching(change, entry)
    if (pending === null) return false
    const notWritten = async (): Promise<false> => {
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
    if (have === null || have.size !== change.size) return notWritten()
    try {
      if ((await this.hash(await this.fs.read(pending.target))) !== change.sha) return notWritten()
    } catch {
      return notWritten()
    }
    if (!sameStat(have, await this.fs.stat(pending.target))) return notWritten()
    await this.remember(change, change.sha, pending.target, have, pending.from)
    return true
  }

  /** A deferred path may adopt bytes already present, but never mutate the filesystem. */
  async adoptExisting(change: ChangeItem, entry: StateEntry | null): Promise<boolean> {
    if (change.op === 'delete' || change.sha === null) return false
    const target = entry !== null && entry.wirePath === change.path ? entry.path : change.path
    const from = entry === null || entry.path === target ? null : entry.path
    if (from !== null && (await this.fs.stat(from)) !== null) return false
    const occupant = await this.state.get(target)
    if (occupant !== null && occupant.fileId !== change.file_id) return false
    const before = await this.fs.stat(target)
    if (before === null) return false
    try {
      if ((await this.hash(await this.fs.read(target))) !== change.sha) return false
    } catch {
      return false
    }
    if (!sameStat(before, await this.fs.stat(target))) return false
    await this.remember(change, change.sha, target, before, from)
    return true
  }

  /**
   * The file is gone from the vault, so it goes from the disk and from the state. False when
   * the disk would not let go of it — a folder or a link has taken the name — and the change
   * is held for a later pull, rather than the whole sync failing on it every time.
   */
  async drop(entry: StateEntry): Promise<boolean> {
    if (!(await this.clearPath(entry.path))) return false
    this.opts.expected.clear(entry.path)
    await this.state.transaction(async () => {
      await this.state.delete(entry.path)
      await this.pending.clear(entry.fileId)
    })
    return true
  }

  /** `remove`, with something in the way reported rather than thrown. */
  private async clearPath(path: string): Promise<boolean> {
    try {
      await this.fs.remove(path)
      return true
    } catch (error) {
      if (!this.inTheWay(error)) throw error
      this.opts.log?.(`pull: ${path} cannot be removed: ${(error as Error).message}`)
      return false
    }
  }

  /** A disk saying something that is not a file holds the path: the adapter's `conflict`. */
  private inTheWay(error: unknown): boolean {
    return error instanceof EngineError && error.code === 'conflict'
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
    const target =
      entry !== null && normalisePath(entry.path) === change.path ? entry.path : change.path
    const from = entry === null || entry.path === target ? null : entry.path

    // The first snapshot precedes the decision. A file created or edited during clear()
    // must not become the new baseline merely because the download has not begun yet.
    const firstTarget = await this.fs.stat(target)
    const beforeFrom = from === null ? null : await this.fs.stat(from)
    if (entry !== null && (await this.edited(entry))) return false
    const state = await this.clear(target, from, change, sha)
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
        if (!(await this.clearPath(from))) return false
      }
      await this.remember(change, sha, target, state.have, from)
      return true
    }

    // The bytes before anything on the disk moves: a server whose blob is not what it says
    // leaves the file where it was, and the change is held with the reason in the log.
    const beforeTarget = state.free
    if (!state.removed && !sameStat(firstTarget, beforeTarget)) return false
    let bytes: Uint8Array | null = null
    if (entry === null || entry.sha !== sha) {
      bytes = await this.bytesOf(sha, fetched, local)
      if (bytes === null) return false
    }
    if (!sameStat(beforeTarget, await this.fs.stat(target))) return false
    if (from !== null && !sameStat(beforeFrom, await this.fs.stat(from))) return false
    // Even a same-size, same-mtime write while the download was in flight is local work.
    if (entry !== null && (await this.edited(entry))) return false

    // What the file will be once this is done: as it was, or exactly what gets written.
    let wrote: { size: number; mtime: number }
    try {
      if (from !== null && (await this.fs.stat(from)) !== null) {
        await this.pending.prepare(change, entry, target, from)
        if (
          !sameStat(beforeFrom, await this.fs.stat(from)) ||
          !sameStat(beforeTarget, await this.fs.stat(target)) ||
          (entry !== null && (await this.edited(entry)))
        ) {
          await this.pending.clear(change.file_id)
          return false
        }
        await this.fs.move(from, target)
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
          (from === null && entry !== null && (await this.edited(entry)))
        ) {
          await this.pending.clear(change.file_id)
          return false
        }
        await writeExpected(this.fs, this.opts.expected, target, sha, bytes, change.mtime ?? 0)
        wrote = { size: bytes.length, mtime: change.mtime ?? 0 }
      }
    } catch (error) {
      // A handled failure is not a crashed write. Do not leave authority to adopt a future edit.
      await this.pending.clear(change.file_id)
      if (!this.inTheWay(error)) throw error
      this.opts.log?.(`pull: ${target} cannot be written: ${(error as Error).message}`)
      return false
    }
    await this.remember(change, sha, target, wrote, from)
    return true
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
    sha: string
  ): Promise<Target> {
    const occupant = await this.state.get(target)
    if (occupant !== null) {
      if (occupant.fileId === change.file_id) return { free: await this.fs.stat(target) }
      if (this.opts.dirty.has(occupant.wirePath) || (await this.edited(occupant))) {
        return 'held'
      }
      if (!(await this.clearPath(occupant.path))) return 'held'
      this.opts.expected.clear(occupant.path)
      await this.state.delete(occupant.path)
      // Our removal authorizes only an absent target. A file saved while the ledger
      // deletion awaited belongs to the user; it must not become our new baseline.
      return { free: null, removed: true }
    }
    const there = await this.fs.stat(target)
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
      return (await this.hash(await this.fs.read(target))) === sha ? { have: there } : 'held'
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
    const event =
      this.opts.onPersonalNoteApplied && change.kind === 'note'
        ? personalNoteDelivery(change)
        : null
    const exact = event ? await this.client.getBlob(sha) : null
    if (event && (!exact || exact.length !== event.size || (await this.hash(exact)) !== event.sha))
      throw new EngineError('protocol', 'personal note delivery integrity mismatch')
    await this.state.transaction(async () => {
      if (from !== null) await this.state.delete(from)
      await this.state.put({
        path: target,
        wirePath: change.path,
        fileId: change.file_id,
        versionId: change.version_id,
        sha,
        size: have.size,
        mtime: have.mtime,
      })
      if (event && exact) await this.opts.onPersonalNoteApplied!(event, exact)
      await this.pending.clear(change.file_id)
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
