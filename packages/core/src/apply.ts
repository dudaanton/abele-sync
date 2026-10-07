import {
  AbeleError,
  normalisePath,
  validatePath,
  type ChangeItem,
  type CommitOpResult,
} from '@abele/sync-protocol'
import type { VaultClient } from './client.js'
import type { ExpectedWrites } from './echo.js'
import type { FileSystem } from './fs.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * The few things the puller and the pusher both do to a disk.
 *
 * Both of them bring the server's bytes down — the puller from the feed, the pusher from
 * the verdict on what it just sent — and both must find those bytes without downloading
 * what this disk already holds, write them without the host's watcher pushing them straight
 * back, and do a bounded number of things at once. That is all this file is; nothing here
 * knows about changes, ops, journals or cursors.
 */

/**
 * How many downloaded bytes the puller's page and the pusher's batch hold before writing them,
 * when the caller names no number (`PullOptions.prefetchBytes`, `ResumeOptions.prefetchBytes`).
 */
export const DEFAULT_PREFETCH_BYTES = 64 * 1024 * 1024

/**
 * Items cut into runs, in order, whose sizes together fit `budget`: a run is closed before
 * the item that would take it over, and an item bigger than the budget on its own is a run
 * of its own. `sizeOf` is what an item will hold once its bytes are in; nothing, for most.
 */
export function runsWithin<T>(items: T[], sizeOf: (item: T) => number, budget: number): T[][] {
  const runs: T[][] = []
  let run: T[] = []
  let bytes = 0
  for (const item of items) {
    const size = sizeOf(item)
    if (run.length > 0 && bytes + size > budget) {
      runs.push(run)
      run = []
      bytes = 0
    }
    run.push(item)
    bytes += size
  }
  if (run.length > 0) runs.push(run)
  return runs
}

/** One synced file per sha, so bytes already on this disk are found without a walk each time. */
export async function shaIndex(state: StateStore): Promise<Map<string, StateEntry>> {
  const index = new Map<string, StateEntry>()
  for await (const entry of state.all()) {
    if (!index.has(entry.sha)) index.set(entry.sha, entry)
  }
  return index
}

/**
 * The bytes for a sha: a local file that still holds them, or the server.
 *
 * Local bytes are always hashed: a matching stat describes the file before the
 * read, not necessarily the bytes the read returns. Reuse must never put one file's
 * bytes under another's name. What the server sends is hashed too, every time: bytes that
 * do not hash to the name they were asked for by are nobody's, and come back as `null`
 * for the caller to hold the change over and say so.
 */
export async function bytesFor(
  client: Pick<VaultClient, 'getBlob'>,
  fs: FileSystem,
  sha: string,
  local: Map<string, StateEntry>,
  hash: (bytes: Uint8Array) => Promise<string>
): Promise<Uint8Array | null> {
  const entry = local.get(sha)
  if (entry !== undefined) {
    const bytes = await readLocal(fs, entry, sha, hash)
    if (bytes !== null) return bytes
  }
  return fetchChecked(client, sha, hash)
}

/** The server's bytes for a sha, or `null` when they do not hash to it. */
export async function fetchChecked(
  client: Pick<VaultClient, 'getBlob'>,
  sha: string,
  hash: (bytes: Uint8Array) => Promise<string>
): Promise<Uint8Array | null> {
  const bytes = await client.getBlob(sha)
  return (await hash(bytes)) === sha ? bytes : null
}

/* ── Paths off the wire ──────────────────────────────────────────────────── */

/**
 * What is wrong with a path the server sent, or `null` when nothing is. The rules are the
 * spec's (§3.8), applied here exactly as the scanner applies them to the disk — and a path
 * the server spelled in any other way than its own normal form is refused too, since every
 * check downstream compares paths as strings. Nothing that fails here reaches an adapter.
 */
export function pathProblem(raw: string): string | null {
  try {
    const path = normalisePath(raw)
    validatePath(path)
    return path === raw ? null : 'not in wire form'
  } catch (error) {
    if (error instanceof AbeleError && typeof error.details['reason'] === 'string') {
      return error.details['reason']
    }
    return error instanceof Error ? error.message : String(error)
  }
}

/** What is wrong with the paths a change carries, or `null`. */
export function changeProblem(change: ChangeItem): string | null {
  const problem = pathProblem(change.path)
  if (problem !== null) return `${problem}: ${change.path}`
  if (change.prev_path === null) return null
  const previous = pathProblem(change.prev_path)
  return previous === null ? null : `${previous}: ${change.prev_path}`
}

/** What is wrong with the paths a commit result carries, or `null`. */
export function resultProblem(result: CommitOpResult): string | null {
  if (result.status === 'rejected') return null
  const problem = pathProblem(result.path)
  if (problem !== null) return `${problem}: ${result.path}`
  if (result.status !== 'conflict') return null
  const copy = pathProblem(result.conflict_path)
  return copy === null ? null : `${copy}: ${result.conflict_path}`
}

/** The bytes an entry's file still holds, if they really are the ones asked for. */
async function readLocal(
  fs: FileSystem,
  entry: StateEntry,
  sha: string,
  hash: (bytes: Uint8Array) => Promise<string>
): Promise<Uint8Array | null> {
  try {
    const have = await fs.stat(entry.path)
    if (have === null) return null
    const bytes = await fs.read(entry.path)
    return (await hash(bytes)) === sha ? bytes : null
  } catch {
    // The file went between the state and the read: the server still has the bytes.
    return null
  }
}

/**
 * A write the engine is making itself, registered before it lands so the host's watcher
 * knows it for the engine's own. A write that never happened leaves no expectation behind:
 * one left here would swallow the next genuine edit of those bytes at that path.
 */
export async function writeExpected(
  fs: FileSystem,
  expected: ExpectedWrites,
  path: string,
  sha: string,
  bytes: Uint8Array,
  mtime: number
): Promise<void> {
  expected.expect(path, sha)
  try {
    await fs.writeAtomic(path, bytes, mtime)
  } catch (error) {
    expected.clear(path)
    throw error
  }
}

/**
 * The size and mtime to file `sha` under at `path`, right after the engine put those bytes
 * there (or found them there). `wrote` is what the engine meant the file to be.
 *
 * The disk is asked, because a disk may round an mtime — but a person may also have typed into
 * the file between the write and this `stat`, and filing the engine's sha under *their* size
 * and mtime would make the scanner call their edit unchanged forever. So a stat that is not
 * exactly what was written is believed only once the bytes behind it hash to `sha`; otherwise
 * what was written is recorded, which the disk no longer matches, so the next scan hashes the
 * file and sends the edit. A file gone by now is recorded as written too: the scan sends that.
 */
export async function settledStat(
  fs: FileSystem,
  path: string,
  sha: string,
  wrote: { size: number; mtime: number },
  hash: (bytes: Uint8Array) => Promise<string>
): Promise<{ size: number; mtime: number }> {
  const have = await fs.stat(path)
  if (have === null) return { size: wrote.size, mtime: wrote.mtime }
  if (have.size === wrote.size && have.mtime === wrote.mtime) return have
  try {
    if ((await hash(await fs.read(path))) === sha) return have
  } catch {
    // Gone or unreadable between the stat and the read: what was written is what is known.
  }
  return { size: wrote.size, mtime: wrote.mtime }
}

/**
 * Run `work` over every item, no more than `limit` of them at once.
 *
 * The first failure stops the dispatch: a run that is going to throw should not spend the
 * rest of its batch asking a server that has just refused, or gone.
 */
export async function pool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return
  let next = 0
  let failed = false
  let firstError: unknown
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    for (let at = next++; at < items.length && !failed; at = next++) {
      const item = items[at]
      if (item === undefined) continue
      try {
        await work(item)
      } catch (error) {
        if (!failed) firstError = error
        failed = true
      }
    }
  })
  // A retry (or shutdown) must never overlap work from the failed run.
  await Promise.all(workers)
  if (failed) throw firstError
}
