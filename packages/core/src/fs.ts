import { caseKey } from '@abele/sync-protocol'
import { EngineError } from './errors.js'

/** A regular file as the host sees it. `path` is on-disk form, `/`-separated and vault-relative. */
export interface FileInfo {
  path: string
  size: number
  mtime: number
}

/**
 * The vault as the engine touches it. The plugin implements this over Obsidian's adapter,
 * the daemon over Node's `fs`; the engine and its tests use `MemoryFileSystem`.
 */
export interface FileSystem {
  /** Every regular file. Symlinks are skipped, directories are never yielded. */
  list(): AsyncIterable<FileInfo>
  /** Throws `EngineError('io')` if the path is missing. */
  read(path: string): Promise<Uint8Array>
  /** Creates parent directories, writes through a temp file and rename, then sets `mtime`. */
  writeAtomic(path: string, bytes: Uint8Array, mtime: number): Promise<void>
  /**
   * Creates parent directories. Fails if `to` already exists — with one exception the engine
   * relies on: when `to` is `from` under another spelling of the same name, a case-only
   * rename on a case-insensitive disk, the file must be renamed rather than the move refused.
   * A host that checks for `to` itself has to make that check case-sensitive, which is what
   * the underlying rename does on its own.
   */
  move(from: string, to: string): Promise<void>
  /** A missing path is not an error. */
  remove(path: string): Promise<void>
  stat(path: string): Promise<FileInfo | null>
  /** Optional. Debounced batches of on-disk paths; the returned function stops watching. */
  watch?(cb: (paths: string[]) => void): () => void
}

interface Entry {
  /** The spelling the file was created or last renamed under. */
  path: string
  bytes: Uint8Array
  mtime: number
}

export interface MemoryFileSystemOptions {
  /**
   * Behave like macOS's APFS and Windows's NTFS: `Note.md`, `note.md` and the NFD spelling of
   * a name are one file, listed under the spelling it was created or renamed with.
   */
  caseInsensitive?: boolean
}

/**
 * A `FileSystem` over a `Map`, for the engine's tests.
 *
 * It holds files and nothing else, so there are no directories to create — `writeAtomic` and
 * `move` create parents by having none. By default paths are keys, compared exactly, so it
 * behaves like a case-sensitive disk: `Note.md` and `note.md` are two files. With
 * `caseInsensitive` it folds case and Unicode normalisation the way a Mac's disk does. Bytes
 * are copied in and out, so no caller can reach into the store through an array it still holds.
 */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Entry>()
  private readonly watchers = new Set<(paths: string[]) => void>()
  private readonly fold: (path: string) => string

  constructor(opts: MemoryFileSystemOptions = {}) {
    this.fold = opts.caseInsensitive === true ? caseKey : (path) => path
  }

  async *list(): AsyncIterable<FileInfo> {
    for (const entry of [...this.files.values()]) yield info(entry.path, entry)
  }

  async read(path: string): Promise<Uint8Array> {
    const entry = this.files.get(this.fold(path))
    if (!entry) throw new EngineError('io', `no such file: ${path}`)
    return entry.bytes.slice()
  }

  async writeAtomic(path: string, bytes: Uint8Array, mtime: number): Promise<void> {
    // A write over a file that is there keeps the name it has, as a rename onto it does.
    const spelled = this.files.get(this.fold(path))?.path ?? path
    this.files.set(this.fold(path), { path: spelled, bytes: bytes.slice(), mtime })
  }

  async move(from: string, to: string): Promise<void> {
    const entry = this.files.get(this.fold(from))
    if (!entry) throw new EngineError('io', `no such file: ${from}`)
    // The one file under another spelling is renamed; anything else at `to` is in the way.
    if (this.fold(from) !== this.fold(to) && this.files.has(this.fold(to))) {
      throw new EngineError('io', `already exists: ${to}`)
    }
    this.files.delete(this.fold(from))
    this.files.set(this.fold(to), { ...entry, path: to })
  }

  async remove(path: string): Promise<void> {
    this.files.delete(this.fold(path))
  }

  async stat(path: string): Promise<FileInfo | null> {
    const entry = this.files.get(this.fold(path))
    return entry ? info(path, entry) : null
  }

  /** Copies of every file, for assertions, under the names they are listed with. */
  snapshot(): Map<string, Uint8Array> {
    return new Map([...this.files.values()].map((entry) => [entry.path, entry.bytes.slice()]))
  }

  watch(cb: (paths: string[]) => void): () => void {
    this.watchers.add(cb)
    return () => {
      this.watchers.delete(cb)
    }
  }

  /** Test hook: pretend the host noticed these paths change on disk. */
  emitChange(paths: string[]): void {
    for (const watcher of [...this.watchers]) watcher(paths)
  }
}

const info = (path: string, entry: Entry): FileInfo => ({
  path,
  size: entry.bytes.length,
  mtime: entry.mtime,
})
