import {
  AbeleError,
  caseKey,
  normalisePath,
  splitPath,
  validatePath,
  type CommitOp,
} from '@abele/sync-protocol'
import type { FileInfo, FileSystem } from './fs.js'
import { sha256 } from './hash.js'
import { alike, comparable } from './likeness.js'
import { isEngineOwn } from './selective.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * The scanner: what is on disk against what was last synced, as the ops a push commits.
 *
 * It is pure. It reads the tree and the state, hashes what it must, and returns what it
 * found; nothing is written to disk and no state entry is touched. The engine takes the
 * `ScanResult`, pushes the ops and records the results, and the `hashes` it kept mean the
 * next scan hashes nothing that did not change.
 *
 * Known limitation: a file whose content changed while its size and mtime stayed exactly
 * what was last synced reads as unchanged and is not hashed — two same-size files swapped
 * by a tool that preserves mtimes, or a restore from a backup that does. It is picked up as
 * soon as anything touches its mtime, and the puller's sha comparison catches it from the
 * other side. Hashing every file on every scan is the only alternative, and a vault is
 * scanned far too often for that.
 */

/** Which files this device syncs at all. In production, `isExcluded` over the settings. */
export interface ScanFilter {
  excluded(wirePath: string, size: number): boolean
}

/** A path the scan passed over, and why. Exclusions are not here: they are not problems. */
export interface SkippedPath {
  /** The on-disk path, as the host spelled it. */
  path: string
  reason: string
}

/**
 * A fresh file named like a synced one but for case or Unicode normalisation: `image.png`
 * beside a synced `Image.png`, which only a case-sensitive disk can hold. The wire and the
 * server hold one file per such name, so the scan sends nothing for it — sent, it would race
 * the synced file on every sync and never get an entry of its own. It stays until somebody
 * renames or removes one of the two.
 */
export interface CaseCollision {
  /** The on-disk path of the file held back. */
  path: string
  wirePath: string
  /** The wire path of the synced file it collides with. */
  with: string
}

export interface ScanResult {
  /** Deletes and moves, then modifies, then creates. See `scan` for why that order. */
  ops: CommitOp[]
  /**
   * wirePath → sha, for every file the scan took in. A file this device excludes, one whose
   * path the wire will not take and one that could not be read are all absent, along with
   * every state entry that has no file on disk.
   */
  hashes: Map<string, string>
  /** The same keys as `hashes`: wirePath → the on-disk spelling, NFD where the wire is NFC. */
  diskPaths: Map<string, string>
  /**
   * The same keys as `hashes`: wirePath → the file as the scan read it. The size and mtime a
   * sha was taken under are what the state records for it — not whatever the file has by the
   * time the push gets there, which may already be the next edit.
   */
  infos: Map<string, FileInfo>
  /** Every wire path an op names; a move names both the old path and the new one. */
  dirty: Set<string>
  skipped: SkippedPath[]
  /** Fresh files held back because a synced file already has their name; see `CaseCollision`. */
  collisions: CaseCollision[]
}

export interface ScanOptions {
  /** The digest, `sha256` by default. Tests count its calls; hosts may cache by inode. */
  hash?: (bytes: Uint8Array) => Promise<string>
  log?: (message: string) => void
  /**
   * The bytes a synced file last held, read by its entry: what a fresh note is compared with
   * to tell an edited rename from a delete and an unrelated create (`likeness.ts`). The engine
   * reads them from the server. Unset, or answering null, the two are never paired.
   */
  previous?: (entry: StateEntry) => Promise<Uint8Array | null>
}

/** The `reason` an `AbeleError` carries, or whatever the failure could say for itself. */
function reasonOf(error: unknown): string {
  if (error instanceof AbeleError && typeof error.details['reason'] === 'string') {
    return error.details['reason']
  }
  return error instanceof Error ? error.message : String(error)
}

/** Ordinal by code unit, so a scan's ops fall the same way on every host and locale. */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The extension a path ends in, folded: `.MD` and `.md` are the same kind of file. */
const extensionOf = (path: string): string => splitPath(path).ext.toLowerCase()

/**
 * Which of several disk spellings of one wire path is the file.
 *
 * The one the state was written against wins, so a stray NFD twin of a synced NFC file can
 * never take that file's place and push its bytes under the entry's id. With nothing synced
 * there yet the ordinal-lowest spelling wins, which at least picks the same one every scan.
 */
function chooseTwin(twins: FileInfo[], entry: StateEntry | undefined): FileInfo {
  const synced = entry && twins.find((twin) => twin.path === entry.path)
  if (synced) return synced
  return twins.reduce((best, twin) => (byPath(twin.path, best.path) < 0 ? twin : best))
}

/**
 * Everything on disk that this device syncs, keyed by wire path.
 *
 * `present` holds every wire path the listing yielded, excluded ones included: a file the
 * settings skip is still there, and must not be mistaken for one that was deleted. The
 * exclusion is applied before twins are resolved, so an over-cap spelling of a path cannot
 * shadow the file this device does sync.
 */
async function walkTree(
  fs: FileSystem,
  filter: ScanFilter,
  entries: Map<string, StateEntry>,
  present: Set<string>,
  skip: (path: string, reason: string) => void
): Promise<Map<string, FileInfo>> {
  const candidates = new Map<string, FileInfo[]>()
  for await (const listed of fs.list()) {
    // The wire has no time before 1970. A host that reports one would have every batch the
    // file is in refused as a whole, so the clock starts at the epoch here whatever it says.
    const info = listed.mtime < 0 ? { ...listed, mtime: 0 } : listed
    let wirePath: string
    try {
      wirePath = normalisePath(info.path)
      // Engine-owned paths are not candidates for the wire, even if the wire forbids them.
      if (isEngineOwn(wirePath)) continue
      validatePath(wirePath)
    } catch (error) {
      skip(info.path, reasonOf(error))
      continue
    }
    present.add(wirePath)
    // The filter owns the engine's own paths too; the guard is here so no filter can lose them.
    if (isEngineOwn(wirePath) || filter.excluded(wirePath, info.size)) continue
    const twins = candidates.get(wirePath)
    if (twins) twins.push(info)
    else candidates.set(wirePath, [info])
  }
  const files = new Map<string, FileInfo>()
  for (const [wirePath, twins] of candidates) {
    const kept = chooseTwin(twins, entries.get(wirePath))
    // Two spellings of one wire path: one is the file, the rest have nowhere on the wire to go.
    for (const twin of twins) if (twin !== kept) skip(twin.path, 'duplicate wire path')
    files.set(wirePath, kept)
  }
  return files
}

/**
 * What was last synced, keyed by wire path.
 *
 * Excluded entries stay in: a file that has come back under the size cap is still that file,
 * and must modify its entry rather than create a second one under the same path. Exclusion
 * decides only whether an entry with no file on disk is deleted, which `scan` does below.
 */
async function readState(state: StateStore): Promise<Map<string, StateEntry>> {
  const entries = new Map<string, StateEntry>()
  for await (const entry of state.all()) {
    if (isEngineOwn(entry.wirePath)) continue
    entries.set(entry.wirePath, entry)
  }
  return entries
}

/**
 * Which lost paths are renames of which fresh ones: `from` wire path → `to` wire path.
 *
 * First by sha, bucketed once on each side and paired only where a sha names exactly one
 * candidate in both — two files with the same content, both renamed, pair with nothing,
 * because guessing which became which would attach the wrong history to both. Buckets, not
 * a scan of the candidates per candidate: the first sync of a large vault is thousands of
 * fresh paths at once, on the host's UI thread.
 *
 * Then a rename that came with an edit: one lost path and one fresh path left over are that
 * same file only when both are notes of one extension and their text is clearly alike —
 * at least half their lines shared (`likeness.ts`). Pairing by elimination alone is unsafe: an unrelated note written as another was deleted would take
 * the deleted note's history, walk past the delete guard as a move, and have another device's
 * edits to the deleted note merged into it. Anything not paired here is a delete, which the
 * guard judges, and a create.
 */
async function pairRenames(
  missing: StateEntry[],
  fresh: string[],
  hashes: Map<string, string>,
  sameFile: (lost: StateEntry, found: string) => Promise<boolean>
): Promise<Map<string, string>> {
  const lost = new Map<string, StateEntry[]>()
  for (const entry of missing) {
    const bucket = lost.get(entry.sha)
    if (bucket) bucket.push(entry)
    else lost.set(entry.sha, [entry])
  }
  const found = new Map<string, string[]>()
  for (const path of fresh) {
    const sha = hashes.get(path)
    if (sha === undefined) continue
    const bucket = found.get(sha)
    if (bucket) bucket.push(path)
    else found.set(sha, [path])
  }

  const moves = new Map<string, string>()
  const moved = new Set<string>()
  for (const [sha, sources] of lost) {
    const targets = found.get(sha)
    const source = sources[0]
    const target = targets?.[0]
    if (sources.length !== 1 || targets?.length !== 1 || !source || target === undefined) continue
    moves.set(source.wirePath, target)
    moved.add(target)
  }

  const leftMissing = missing.filter((entry) => !moves.has(entry.wirePath))
  const leftFresh = fresh.filter((path) => !moved.has(path))
  const lostOne = leftMissing[0]
  const freshOne = leftFresh[0]
  if (
    leftMissing.length === 1 &&
    leftFresh.length === 1 &&
    lostOne &&
    freshOne &&
    extensionOf(lostOne.wirePath) === extensionOf(freshOne) &&
    (await sameFile(lostOne, freshOne))
  ) {
    moves.set(lostOne.wirePath, freshOne)
  }
  return moves
}

/**
 * Read the vault and say what to commit.
 *
 * A file whose `(size, mtime)` still match its state entry is unchanged and keeps that
 * entry's sha unhashed; anything else is hashed, and an equal sha is no op at all — the
 * caller refreshes the entry's mtime from `hashes` so the next scan is cheap again.
 *
 * The ops come out in the order they must be applied: deletes and moves first, so a move
 * lands on a path this very batch frees, then modifies, then creates.
 */
export async function scan(
  fs: FileSystem,
  state: StateStore,
  filter: ScanFilter,
  opts: ScanOptions = {}
): Promise<ScanResult> {
  const hash = opts.hash ?? sha256
  const skipped: SkippedPath[] = []
  const skip = (path: string, reason: string): void => {
    skipped.push({ path, reason })
    opts.log?.(`scan: skipped ${path}: ${reason}`)
  }

  const present = new Set<string>()
  const entries = await readState(state)
  const files = await walkTree(fs, filter, entries, present, skip)

  // The names synced files still hold on this disk. A synced file that is gone frees its name,
  // so a case-only rename on a case-sensitive disk is still paired into a move below.
  const synced = new Map<string, string>()
  for (const entry of entries.values()) {
    if (present.has(entry.wirePath)) synced.set(caseKey(entry.wirePath), entry.wirePath)
  }

  const hashes = new Map<string, string>()
  const diskPaths = new Map<string, string>()
  const infos = new Map<string, FileInfo>()
  const modifies: Array<{ path: string; op: CommitOp }> = []
  const fresh: string[] = []
  const collisions: CaseCollision[] = []
  for (const [wirePath, info] of files) {
    const entry = entries.get(wirePath)
    const twin = entry ? undefined : synced.get(caseKey(wirePath))
    if (twin !== undefined) {
      collisions.push({ path: info.path, wirePath, with: twin })
      continue
    }
    if (entry && entry.size === info.size && entry.mtime === info.mtime) {
      hashes.set(wirePath, entry.sha)
      diskPaths.set(wirePath, info.path)
      infos.set(wirePath, info)
      continue
    }
    let sha: string
    try {
      sha = await hash(await fs.read(info.path))
    } catch (error) {
      // Read after list is a race: the file may be gone or locked. Leave it for the next scan.
      skip(info.path, reasonOf(error))
      continue
    }
    hashes.set(wirePath, sha)
    diskPaths.set(wirePath, info.path)
    infos.set(wirePath, info)
    if (!entry) {
      fresh.push(wirePath)
    } else if (sha !== entry.sha) {
      modifies.push({
        path: wirePath,
        op: {
          op: 'modify',
          file_id: entry.fileId,
          base_version_id: entry.versionId,
          sha,
          size: info.size,
          mtime: info.mtime,
        },
      })
    }
  }

  // An entry this device no longer syncs is left where it is: excluded files are not deleted
  // from the vault on the strength of a setting.
  const missing = [...entries.values()].filter(
    (entry) => !present.has(entry.wirePath) && !filter.excluded(entry.wirePath, entry.size)
  )
  fresh.sort(byPath)
  missing.sort((a, b) => byPath(a.wirePath, b.wirePath))
  const moves = await pairRenames(missing, fresh, hashes, async (lost, found) => {
    const path = diskPaths.get(found)
    if (opts.previous === undefined || path === undefined || !comparable(found)) return false
    try {
      const before = await opts.previous(lost)
      return before !== null && alike(before, await fs.read(path))
    } catch {
      // Either side unreadable: nothing to judge the likeness by, so they are not paired.
      return false
    }
  })

  const ops: CommitOp[] = []
  const dirty = new Set<string>()
  for (const entry of missing) {
    if (moves.has(entry.wirePath)) continue
    ops.push({ op: 'delete', file_id: entry.fileId, base_version_id: entry.versionId })
    dirty.add(entry.wirePath)
  }
  for (const entry of missing) {
    const to = moves.get(entry.wirePath)
    if (to === undefined) continue
    ops.push({
      op: 'move',
      file_id: entry.fileId,
      base_version_id: entry.versionId,
      to_path: to,
    })
    dirty.add(entry.wirePath)
    dirty.add(to)
    // A rename by sha needs nothing more; a rename that came with an edit needs its bytes.
    const info = files.get(to)
    const sha = hashes.get(to)
    if (info && sha !== undefined && sha !== entry.sha) {
      modifies.push({
        path: to,
        op: {
          op: 'modify',
          file_id: entry.fileId,
          base_version_id: entry.versionId,
          sha,
          size: info.size,
          mtime: info.mtime,
        },
      })
    }
  }
  modifies.sort((a, b) => byPath(a.path, b.path))
  for (const { path, op } of modifies) {
    ops.push(op)
    dirty.add(path)
  }
  const movedTo = new Set(moves.values())
  for (const wirePath of fresh) {
    if (movedTo.has(wirePath)) continue
    const info = files.get(wirePath)
    const sha = hashes.get(wirePath)
    if (!info || sha === undefined) continue
    ops.push({ op: 'create', path: wirePath, sha, size: info.size, mtime: info.mtime })
    dirty.add(wirePath)
  }

  collisions.sort((a, b) => byPath(a.wirePath, b.wirePath))
  return { ops, hashes, diskPaths, infos, dirty, skipped, collisions }
}
