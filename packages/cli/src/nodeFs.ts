import { randomBytes } from 'node:crypto'
import { constants, existsSync, rmSync, watch as watchTree, type FSWatcher } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { EngineError, isHidden, type FileInfo, type FileSystem } from '@abele/sync-core'
import { caseKey } from '@abele/sync-protocol'
import { syncParents, syncPath } from './nodeFsDurability.js'
import {
  containedIn,
  isMissing,
  ownTempFolder,
  realTempFolder,
  sweepTempFolder,
} from './nodeFsGuard.js'

/** The engine's own folder inside a vault: its state, its lock, its temp files. */
export const STATE_DIR = '.abele-sync'

const TMP_DIR = 'tmp'
/** How long the watcher waits for the burst to end before it reports a batch. */
const WATCH_DEBOUNCE_MS = 300
/** How long a batch may be held back by a burst that never lets up. */
const WATCH_MAX_WAIT_MS = 2000
/** How far apart `sizeStable` takes its two readings. */
const STABLE_GAP_MS = 200

export interface NodeFileSystemOptions {
  /**
   * Extra folder names skipped by `list` and by the watcher. Root-relative and root-only: a
   * vault folder that happens to carry one of these names deeper down is synced like any other.
   *
   * `.abele-sync` is always skipped, whatever is passed here — it holds the device token and the
   * adapter's own half-written files, and it is not the caller's to opt back in.
   */
  ignoreDirs?: string[]
  /**
   * Leave hidden paths alone, as the daemon does: `list` does not descend into a folder whose
   * name starts with a dot — `.obsidian` at the root apart — and the watcher reports nothing
   * from any hidden path (`isHidden`). A `.git` is then neither walked on every scan nor a
   * reason to wake one. Hidden *files* are still listed; the scan's filter passes over them.
   */
  skipHidden?: boolean
}

/**
 * The vault on a real disk, for the daemon.
 *
 * Names are passed through exactly as the OS reports them — a decomposed name on macOS is listed
 * decomposed — because the on-disk spelling is what `move` and `remove` have to name later; the
 * engine folds a path to NFC itself when it puts it on the wire. `mtime` is `mtimeMs` rounded, so
 * it matches what the wire carries whatever precision the filesystem keeps.
 *
 * Everything the adapter writes on its own way through goes to `<root>/.abele-sync/tmp`, which
 * `list` skips: a half-written file is never a file the scanner can see. What a crash left there
 * is swept by `sweepTemp`, which the daemon calls once it holds the lock and nobody else does.
 */
export class NodeFileSystem implements FileSystem {
  private readonly ignoreDirs: ReadonlySet<string>
  private readonly skipHidden: boolean
  /**
   * Whether this platform watches a whole tree at once. Probed once, at construction, because a
   * host that cannot watch has to fall back to the periodic sync before it starts the engine.
   * The root must exist by then; a missing root reads as unsupported.
   */
  readonly supportsWatch: boolean
  /** Present only when `supportsWatch`, so the engine's `fs.watch !== undefined` test is honest. */
  readonly watch?: (cb: (paths: string[]) => void) => () => void

  /** The root resolved once: what every path is built from and tested against. */
  private readonly base: string

  constructor(
    private readonly root: string,
    options: NodeFileSystemOptions = {}
  ) {
    this.base = resolve(root)
    this.ignoreDirs = new Set([STATE_DIR, ...(options.ignoreDirs ?? [])])
    this.skipHidden = options.skipHidden === true
    this.supportsWatch = supportsRecursiveWatch(root)
    if (this.supportsWatch) this.watch = (cb) => this.startWatch(cb)
  }

  async *list(): AsyncIterable<FileInfo> {
    yield* this.walk(this.base, '')
  }

  /**
   * Clear whatever a killed process left in the temp folder. For the one process that holds
   * the vault's lock, and only once it does: a `status` beside a running daemon must not sweep
   * away the download that daemon is in the middle of.
   */
  sweepTemp(): void {
    // Never through a link: an engine folder or temp folder that is one is left alone.
    sweepTempFolder(realTempFolder(this.base, STATE_DIR, TMP_DIR))
  }

  /** The temp folder gone altogether, for a clean exit; nothing of the vault's is in it. */
  removeTemp(): void {
    const folder = realTempFolder(this.base, STATE_DIR, TMP_DIR)
    if (folder === null) return
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch {
      /* a folder that will not go is not worth failing an exit over */
    }
  }

  /**
   * The file's bytes, from the file that was looked at: opened without following a link at its
   * own name, and then made sure of — its folders looked at again and its identity compared with
   * what the path names now — so a folder swapped for a link between the look and the open
   * reads nothing from where the link points.
   */
  async read(path: string): Promise<Uint8Array> {
    const target = await this.contained(path)
    try {
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const opened = await handle.stat()
        await this.contained(path)
        const named = await lstat(target)
        if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
          throw new EngineError('conflict', `${path} changed under the read; nothing was read`)
        }
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    } catch (cause) {
      if (cause instanceof EngineError) throw cause
      throw new EngineError('io', `cannot read ${path}`, cause)
    }
  }

  async writeAtomic(path: string, bytes: Uint8Array, mtime: number): Promise<void> {
    const target = await this.contained(path)
    await this.onlyFileOrNothing(target, path)
    const temp = await this.tempPath()
    try {
      await writeFile(temp, bytes)
      // utimes takes seconds and sets both times, so the file's own atime is read back and put
      // straight again: only the mtime is ours to say. The file carries it before it has a name.
      const written = await lstat(temp)
      await utimes(temp, written.atime, mtime / 1000)
      await syncPath(temp)
      await mkdir(dirname(target), { recursive: true })
      // Looked at again right before the rename: a folder swapped for a link since the first
      // look is refused here rather than written through.
      await this.contained(path)
      await this.onlyFileOrNothing(target, path)
      await rename(temp, target)
      await syncParents(target, this.base)
      await syncParents(temp, this.base)
    } catch (cause) {
      await unlink(temp).catch(() => {})
      if (cause instanceof EngineError) throw cause
      throw new EngineError('io', `cannot write ${path}`, cause)
    }
  }

  async move(from: string, to: string): Promise<void> {
    const source = await this.contained(from)
    const target = await this.contained(to)
    if (source === target) {
      if (!(await this.stat(from))) throw new EngineError('io', `no such file: ${from}`)
      return
    }
    // Neither end may be a folder or a link: the engine believes it is moving a file onto a
    // free name, and a rename would happily carry a folder across or land on top of a link.
    await this.onlyFileOrNothing(source, from)
    await this.onlyFileOrNothing(target, to)
    if (await exists(target)) {
      // A case-only rename on a case-folding disk finds the source under the target's spelling.
      // The rename must happen anyway (ruled 2026-09-05), so it is tried outright first: APFS
      // and NTFS take the new spelling that way.
      if (caseKey(from) !== caseKey(to) || !(await sameFile(source, target))) {
        throw new EngineError('io', `already exists: ${to}`)
      }
      try {
        await this.recheck(from, to)
        await rename(source, target)
        if (await spelledExactly(target)) {
          await syncParents(target, this.base)
          return
        }
        // POSIX lets rename(2) do nothing at all when both names resolve to one file, and some
        // mounts take it literally. Then the new spelling has to be taken in two steps, through
        // the temp folder, where a crash leaves nothing loose in the vault for the scanner.
        const temp = await this.tempPath()
        await rename(target, temp)
        await rename(temp, target)
        await syncParents(target, this.base)
        await syncParents(temp, this.base)
      } catch (cause) {
        if (cause instanceof EngineError) throw cause
        throw new EngineError('io', `cannot rename ${from} to ${to}`, cause)
      }
      return
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      await this.recheck(from, to)
      await rename(source, target)
      await syncParents(target, this.base)
      await syncParents(source, this.base)
    } catch (cause) {
      if (cause instanceof EngineError) throw cause
      throw new EngineError('io', `cannot move ${from} to ${to}`, cause)
    }
    await this.pruneAbove(from)
  }

  /** Both ends of a move looked at again, right before the rename (see `nodeFsGuard.ts`). */
  private async recheck(from: string, to: string): Promise<void> {
    await this.onlyFileOrNothing(await this.contained(from), from)
    await this.onlyFileOrNothing(await this.contained(to), to)
  }

  async remove(path: string): Promise<void> {
    const target = await this.contained(path)
    await this.onlyFileOrNothing(target, path)
    // Looked at again right before the unlink: its folders may have been swapped meanwhile.
    await this.contained(path)
    try {
      await unlink(target)
      await syncParents(target, this.base)
    } catch (cause) {
      if (isMissing(cause)) return
      throw new EngineError('io', `cannot remove ${path}`, cause)
    }
    await this.pruneAbove(path)
  }

  /**
   * The folders above a file the engine has just taken away, removed while that has left them
   * empty — the folder another device renamed or emptied, which Obsidian would otherwise go on
   * showing here. Only ever folders that held the file a moment ago, so a folder somebody left
   * empty themselves is never touched; `rmdir` refuses anything not empty (a `.DS_Store` is
   * enough), and the first refusal ends the climb. Never the vault itself, never the state folder.
   */
  private async pruneAbove(path: string): Promise<void> {
    const segments = path.split('/').slice(0, -1)
    while (segments.length > 0) {
      const folder = segments.join('/')
      if (this.isIgnored(folder)) return
      try {
        await rmdir(await this.contained(folder))
      } catch {
        return
      }
      segments.pop()
    }
  }

  async stat(path: string): Promise<FileInfo | null> {
    let absolute
    try {
      absolute = await this.contained(path)
    } catch (cause) {
      // A file beneath a link is not one the vault holds, as the walk does not list it either.
      if (cause instanceof EngineError && cause.code === 'conflict') return null
      throw cause
    }
    return this.statAt(absolute, path)
  }

  /**
   * Whether the file looks finished: two stats `STABLE_GAP_MS` apart that agree on size and
   * mtime. The daemon asks before it hashes, so a file still being copied into the vault waits
   * for the next scan instead of being uploaded half-written.
   */
  async sizeStable(path: string): Promise<boolean> {
    const first = await this.stat(path)
    if (!first) return false
    await delay(STABLE_GAP_MS)
    const second = await this.stat(path)
    return second !== null && second.size === first.size && second.mtime === first.mtime
  }

  /** Depth-first, ignoring what vanishes under us: a scan races with whoever is editing. */
  private async *walk(directory: string, prefix: string): AsyncIterable<FileInfo> {
    let entries
    try {
      entries = await opendir(directory)
    } catch (cause) {
      if (isMissing(cause)) return
      throw new EngineError('io', `cannot list ${prefix === '' ? '.' : prefix}`, cause)
    }
    for await (const entry of entries) {
      if (prefix === '' && this.ignoreDirs.has(entry.name)) continue
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      // A dirent describes the entry itself, so a symlink is a symlink whatever it points at.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (this.skipHidden && isHiddenFolder(entry.name, prefix)) continue
        yield* this.walk(join(directory, entry.name), path)
        continue
      }
      if (!entry.isFile()) continue
      const info = await this.statAt(join(directory, entry.name), path)
      if (info) yield info
    }
  }

  private async statAt(absolute: string, path: string): Promise<FileInfo | null> {
    try {
      const stats = await lstat(absolute)
      if (!stats.isFile()) return null
      // The wire has no time before 1970; a file that claims one is dated at the epoch.
      return { path, size: stats.size, mtime: Math.max(0, Math.round(stats.mtimeMs)) }
    } catch (cause) {
      if (isMissing(cause)) return null
      throw new EngineError('io', `cannot stat ${path}`, cause)
    }
  }

  /**
   * A folder or a link where the engine expects a file, or nothing, is `conflict` rather than
   * `io`: the engine holds the change and says so, instead of failing every sync on a rename
   * over a directory. The link itself is what is looked at, never what it points to.
   */
  private async onlyFileOrNothing(absolute: string, path: string): Promise<void> {
    let stats
    try {
      stats = await lstat(absolute)
    } catch (cause) {
      if (isMissing(cause)) return
      throw new EngineError('io', `cannot stat ${path}`, cause)
    }
    if (stats.isFile()) return
    const what = stats.isSymbolicLink() ? 'a link' : stats.isDirectory() ? 'a folder' : 'something'
    throw new EngineError('conflict', `${what} is at ${path}, where a file was expected`)
  }

  /** A fresh name in `<root>/.abele-sync/tmp`, folders created, and neither of them a link. */
  private async tempPath(): Promise<string> {
    const folder = await ownTempFolder(this.base, STATE_DIR, TMP_DIR)
    return join(folder, randomBytes(12).toString('hex'))
  }

  /** `path` under the root, every folder above it a real one (`containedIn`). */
  private contained(path: string): Promise<string> {
    return containedIn(this.base, path)
  }

  private startWatch(cb: (paths: string[]) => void): () => void {
    const pending = new Set<string>()
    let timer: NodeJS.Timeout | undefined
    let firstPendingAt = 0
    let stopped = false
    // Batches are taken when their timer fires and reported one after another, so the callback
    // sees them in the order the disk made them however long a stat takes.
    let queue: Promise<void> = Promise.resolve()
    const echo = this.echoFilter()
    const report = async (paths: string[]): Promise<void> => {
      if (stopped) return
      const kept = await echo(paths)
      if (kept.length > 0 && !stopped) cb(kept)
    }
    const fire = (): void => {
      timer = undefined
      firstPendingAt = 0
      if (pending.size === 0) return
      const paths = [...pending]
      pending.clear()
      queue = queue.then(() => report(paths)).catch(() => {})
    }
    let watcher: FSWatcher
    try {
      watcher = watchTree(this.base, { recursive: true }, (_event, name) => {
        if (name === null) return
        const path = name.split(sep).join('/')
        if (path === '' || this.isIgnored(path)) return
        pending.add(path)
        const now = Date.now()
        if (firstPendingAt === 0) firstPendingAt = now
        // Past the ceiling the running timer is left alone, so a burst that never lets up
        // still hands over what it has instead of holding everything to the end.
        if (timer && now - firstPendingAt >= WATCH_MAX_WAIT_MS) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(fire, WATCH_DEBOUNCE_MS)
        timer.unref()
      })
    } catch (cause) {
      throw new EngineError('io', `cannot watch ${this.root}`, cause)
    }
    // A watcher that dies takes the vault's changes with it; the daemon's periodic sync covers it.
    watcher.on('error', () => watcher.close())
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      watcher.close()
    }
  }

  /**
   * Drops one thing from a batch and passes everything else through: the name macOS reports for
   * a change to the vault folder itself, which is the vault folder's own name.
   *
   * Folders stay in. macOS reports a folder moved into the vault and nothing about the notes
   * inside it, so a batch of one folder path is the only word the engine gets that a dozen new
   * notes arrived; it stats such a path as `null` and takes the batch as a reason to scan.
   *
   * A real file at `<root>/<vault name>` is not the echo, so it is reported — and so is its
   * deletion, which the filter knows by having reported the file itself a moment before. The
   * state starts from the disk, so a file that was already there is not mistaken for an echo.
   */
  private echoFilter(): (paths: string[]) => Promise<string[]> {
    const name = basename(this.base)
    let fileExisted = existsSync(join(this.base, name))
    return async (paths: string[]): Promise<string[]> => {
      const kept: string[] = []
      for (const path of paths) {
        if (path === name) {
          const there = await exists(join(this.base, name))
          const real = there || fileExisted
          fileExisted = there
          if (!real) continue
        }
        kept.push(path)
      }
      return kept
    }
  }

  private isIgnored(path: string): boolean {
    const [top] = path.split('/')
    if (top !== undefined && this.ignoreDirs.has(top)) return true
    return this.skipHidden && path !== OBSIDIAN_DIR && isHidden(path)
  }
}

/** The one hidden folder a vault syncs, and only at its root. */
const OBSIDIAN_DIR = '.obsidian'

const isHiddenFolder = (name: string, prefix: string): boolean =>
  name.startsWith('.') && !(prefix === '' && name === OBSIDIAN_DIR)

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether the folder holds this exact name, which is how a rename is known to have taken. */
async function spelledExactly(absolute: string): Promise<boolean> {
  try {
    return (await readdir(dirname(absolute))).includes(basename(absolute))
  } catch {
    return false
  }
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await lstat(absolute)
    return true
  } catch {
    return false
  }
}

/** Whether two names are the same directory entry — how a case-folding disk gives itself away. */
async function sameFile(one: string, other: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([lstat(one), lstat(other)])
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

/** Recursive `fs.watch` is macOS, Windows and Linux since Node 20 — but not every mount. */
function supportsRecursiveWatch(root: string): boolean {
  try {
    watchTree(root, { recursive: true, persistent: false }).close()
    return true
  } catch {
    return false
  }
}
