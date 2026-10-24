import { caseKey } from '@abele/sync-protocol'
import { pathAdmission, type PathAdmission } from './pathAdmission.js'
import { EngineError } from './errors.js'
import type { StreamingFileSystem } from './streaming.js'
import { fingerprintSource } from './streaming.js'
import { checkCancellation } from './cancellation.js'
import { sha256 as digest } from '@noble/hashes/sha256'

export interface FileVersion {
  identity?: string
  size: number
  mtime: number
  sha: string
}
export interface ConditionalFileOperation {
  path: string
  expected: FileVersion | null
  /** Removal-only. Hosts advertising conditionalOwnership check this after capturing/comparing
   * the victim, before retiring its bytes. False preserves it without overwriting
   * a newer public occupant. The callback is not a durable replay permission. */
  authorize?: () => Promise<boolean>
  effect:
    | { kind: 'remove' }
    | { kind: 'move'; to: string }
    | { kind: 'write'; bytes: Uint8Array; mtime: number; receipt?: string }
    | { kind: 'install'; stageId: string }
}

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
export interface FileSystem extends Partial<StreamingFileSystem> {
  [pathAdmission]?(path: string): PathAdmission
  /** conditionalFile enforces operation.authorize at its mutation boundary. */
  readonly conditionalOwnership?: true
  /** Optional durable object identity, stable across rename, different after
   * replacement even for equal bytes/stat. Hosts exposing this MUST enforce
   * expected.identity in conditionalFile at the captured-object boundary. */
  fileIdentity?(path: string): Promise<string | null>
  /** Stable collision key for vault-relative names, including parent components.
   * Equal keys mean names may address one file. Report the host's case/Unicode
   * rules, never content hashes or inode numbers (hard links remain distinct names).
   * Omission conservatively folds case and Unicode; it must not imply exact names. */
  pathKey?(path: string): string
  /** Apply an effect only after accepting its expected base (see docs/core-v2-engine.md#filesystem-host-contract).
   * Exclusive hosts compare the displaced regular file at the mutation boundary and
   * publish into an exclusive destination. Checked hosts compare fresh SHA-256/size,
   * record size/mtime, drain pending host saves, and stat again immediately before
   * mutation. Changed stamps, non-files, content mismatches and occupied create/move
   * destinations return false (local-change refusal); operational errors still throw.
   * Expected absence requires absence checks and create-if-absent publication; an
   * already absent removal may succeed after the write barrier and a second check.
   * Checked hosts cannot exclude an edit in the final check-to-mutation interval and
   * must document that limit: success is not object identity or atomic exclusion.
   * Preserve displaced bytes in durable quarantine, restore mismatches without
   * overwriting occupants, retain uncertain evidence, and retire verified victims.
   * Only exclusive hosts with durable object/content proof can adopt an installation
   * after a crash. Checked installedFile/AtomicStage.installed return false; matching
   * bytes, intent or a sealed stage never authorize blind recovery publication.
   * Absence of this port fails closed; lack of object identity alone does not. */
  conditionalFile?(operation: ConditionalFileOperation): Promise<boolean>
  /** Exclusive publication evidence, not equality: the named file is this installation's
   * object with proven content. Checked hosts always return false, conservatively. */
  installedFile?(receipt: string, path: string, sha: string): Promise<boolean>
  discardInstallation?(receipt: string): Promise<void>
  recoverConditionalFiles?(): Promise<void>
  /** Every regular file. Symlinks are skipped, directories are never yielded. */
  list(): AsyncIterable<FileInfo>
  /** Stable local directory identities let a rename preserve its server selector. */
  listDirectories?(): AsyncIterable<{ path: string; identity: string; mtime: number }>
  /** Raw immediate children for bounded alias rechecks; never collapse Unicode spellings. */
  listChildren?(
    parent: string
  ): Promise<Array<{ path: string; kind: 'file' | 'directory'; identity?: string }>>
  /** A definitive per-path refusal may throw AbeleError (quota_exceeded, leaves_scope,
   * invalid_path, too_large, scripts_forbidden, path_taken, case_collision or forbidden).
   * Ordinary I/O errors must retain their error type and abort the run. */
  mkdir?(path: string): Promise<void>
  moveDirectory?(from: string, to: string): Promise<void>
  /** Removes only an empty directory: untracked/local bytes are never swept recursively. */
  removeDirectory?(path: string, expectedIdentity?: string): Promise<void>
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

/** Binary identity checks prefer bounded host I/O, including recovery checks. */
export async function fingerprintFile(
  fs: FileSystem,
  path: string,
  hash: (bytes: Uint8Array) => Promise<string>,
  signal?: AbortSignal
): Promise<{ size: number; sha: string }> {
  checkCancellation(signal)
  if (fs.fingerprint) return fs.fingerprint(path, signal)
  if (fs.openRead) return fingerprintSource(await fs.openRead(path), undefined, signal)
  const bytes = await fs.read(path)
  return { size: bytes.length, sha: await hash(bytes) }
}

interface Entry {
  identity: string
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
  /** Fold canonical Unicode spellings without folding case. */
  normalizing?: boolean
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
  readonly conditionalOwnership = true as const
  private nextIdentity = 0
  async fileIdentity(path: string): Promise<string | null> {
    return this.files.get(this.fold(path))?.identity ?? null
  }
  private readonly installations = new Map<string, Entry>()
  private readonly files = new Map<string, Entry>()
  private readonly watchers = new Set<(paths: string[]) => void>()
  private readonly fold: (path: string) => string

  constructor(opts: MemoryFileSystemOptions = {}) {
    this.fold =
      opts.caseInsensitive === true
        ? caseKey
        : opts.normalizing
          ? (path) => path.normalize('NFC')
          : (path) => path
  }

  pathKey(path: string): string {
    return this.fold(path)
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
    this.files.set(this.fold(path), {
      path: spelled,
      bytes: bytes.slice(),
      mtime,
      identity: String(++this.nextIdentity),
    })
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

  async conditionalFile(op: ConditionalFileOperation): Promise<boolean> {
    if (op.authorize && op.effect.kind !== 'remove')
      throw new Error('conditional ownership is only supported for removal')
    if (op.authorize && !(await op.authorize())) return false
    // No await between comparison and mutation: one indivisible in-memory operation.
    const key = this.fold(op.path),
      current = this.files.get(key)
    if (!current && op.effect.kind === 'remove') return true
    if (
      op.expected === null
        ? current !== undefined
        : !current ||
          (op.expected.identity !== undefined && current.identity !== op.expected.identity) ||
          current.bytes.length !== op.expected.size ||
          current.mtime !== op.expected.mtime ||
          Array.from(digest(current.bytes), (b) => b.toString(16).padStart(2, '0')).join('') !==
            op.expected.sha
    )
      return false
    if (op.effect.kind === 'remove') this.files.delete(key)
    else if (op.effect.kind === 'move') {
      if (!current || (this.fold(op.effect.to) !== key && this.files.has(this.fold(op.effect.to))))
        return false
      this.files.delete(key)
      this.files.set(this.fold(op.effect.to), { ...current, path: op.effect.to })
    } else if (op.effect.kind === 'write') {
      const installed = {
        identity: String(++this.nextIdentity),
        path: current?.path ?? op.path,
        bytes: op.effect.bytes.slice(),
        mtime: op.effect.mtime,
      }
      this.files.set(key, installed)
      if (op.effect.receipt) this.installations.set(op.effect.receipt, installed)
    } else return false
    return true
  }
  async installedFile(receipt: string, path: string, sha: string): Promise<boolean> {
    const entry = this.files.get(this.fold(path))
    return (
      entry !== undefined &&
      this.installations.get(receipt) === entry &&
      Array.from(digest(entry.bytes), (b) => b.toString(16).padStart(2, '0')).join('') === sha
    )
  }
  async discardInstallation(receipt: string): Promise<void> {
    this.installations.delete(receipt)
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
