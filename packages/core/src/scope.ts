import type { FileSystem } from './fs.js'
import { IgnoreRules } from './ignore.js'
import { unguarded } from './guard.js'
import type { ScanFilter } from './scanner.js'
import { isEngineOwn, isExcluded, type SelectiveSettings } from './selective.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * The synced files that have been out of this device's scope since this device last saw them
 * in it: what a narrowing took, still waiting for the widening that gives it back.
 *
 * A ledger entry says "this file was here, synced, at this version". While a file is out of
 * scope this device stops watching it, so when the scope widens again the entry no longer
 * says anything about the disk: the file may have been deleted here to free space, deleted on
 * the server, or edited on either side. Read as usual, a missing file would be a delete and
 * the scan would send it — to every device (three-node report, B2). So every entry the current
 * scope excludes is marked, and a marked entry that comes back into scope is not read as usual:
 *
 * - its file is gone from this disk: the entry is dropped, never sent as a delete. The manifest
 *   walk that follows a widening then fetches the server's copy, if there still is one.
 * - its file is still here: it is checked against the manifest. A file the server no longer
 *   lists was deleted elsewhere while this device was not looking, and goes here too, unless it
 *   was edited here meanwhile — then the scan sends the edit, and the server keeps the file.
 *
 * A delete made in scope and caught by a narrowing before it was pushed looks exactly like one
 * made out of scope. It is treated the same way: the file comes back, and nothing is lost.
 *
 * The marks are filed in the state under one key, so a host that rebuilds the engine on a
 * scope change — both do — hands the new engine what the old one saw. They are taken when an
 * engine is built and when it starts, and again at the start of every run, never asking the
 * server anything: a paused plugin rebuilds the engine on a scope change and runs nothing, and
 * a narrowing must be on file before anything is deleted under it.
 *
 * Beside the marks the state keeps the scope they were last taken under (`ScopeRecord`). A
 * later engine built on another scope marks again what that one left out, so marks lost to a
 * rollback or a crash are taken back. A ledger with no scope on file at all was kept by a build
 * that took no marks: what that build's scope left out cannot be known, so once, at the first
 * engine built over it, every synced file missing from the disk is marked. A delete made under
 * that build and not yet sent comes back rather than go; nothing is lost either way.
 */

const MARKS_KEY = 'out-of-scope-files'
const SCOPE_KEY = 'marked-scope'

/** The scope marks were taken under, as filed: enough to build its filter again. */
export interface ScopeRecord {
  selective: SelectiveSettings
  scriptsFolder: string
  /** The ignore file's text; null for none, absent when the host did not say. */
  ignore?: string | null
}

/**
 * Marks are read and written one call at a time per `StateStore` object in this process, so
 * engines a host builds back to back over the same store object never interleave their reads
 * and writes. That is all it guarantees: two store objects over one database (the plugin opens
 * a new one for every engine it builds) are two queues, and `stop()` does not wait for a
 * marking in flight. A mark one of those loses by a write over it is not lost for good: the
 * next `record` marks it again, as excluded by its own scope or, under another one, by the
 * scope on file.
 */
const queues = new WeakMap<StateStore, Promise<unknown>>()

function serially<T>(store: StateStore, fn: () => Promise<T>): Promise<T> {
  // The store itself, whether or not the engine sees it through its `stillHeld` guard.
  const state = unguarded(store)
  const run = (queues.get(state) ?? Promise.resolve()).then(fn, fn)
  queues.set(
    state,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/** What reviewing the scope found: entries dropped, and files to check against the manifest. */
export interface ScopeReview {
  /** Wire paths of entries whose file went while out of scope; each was dropped from the state. */
  forgotten: string[]
  /** File ids back in scope with their file still here, for the manifest walk to confirm. */
  recheck: Set<string>
}

export class ScopeMarks {
  /** The marks, for a store that cannot file them: kept for as long as this engine lives. */
  private memory: Set<string> | null = null

  constructor(private readonly state: StateStore) {}

  /**
   * Mark what the scope excludes now, and what the scope on file excluded if it was another;
   * then file this scope. Neither the server nor, but for a ledger no scope was ever filed for,
   * the disk is asked anything.
   */
  record(fs: FileSystem, scope: ScopeRecord, filter: ScanFilter): Promise<void> {
    return serially(this.state, async () => {
      const marks = await this.load()
      const entries = await this.entries()
      const raw = this.state.getMeta ? await this.state.getMeta(SCOPE_KEY) : null
      const previous = raw === null ? null : parseRecord(raw)
      let changed = false
      const mark = (entry: StateEntry): void => {
        if (marks.has(entry.fileId)) return
        marks.add(entry.fileId)
        changed = true
      }
      for (const entry of entries) {
        if (isEngineOwn(entry.wirePath)) continue
        if (filter.excluded(entry.wirePath, entry.size)) mark(entry)
      }
      if (this.state.getMeta !== undefined && raw === null) {
        for (const entry of entries) {
          if (isEngineOwn(entry.wirePath) || marks.has(entry.fileId)) continue
          if ((await fs.stat(entry.path)) === null) mark(entry)
        }
      } else if (previous !== null && canonical(previous) !== canonical(scope)) {
        const before = filterOf(previous)
        for (const entry of entries) {
          if (isEngineOwn(entry.wirePath)) continue
          if (before.excluded(entry.wirePath, entry.size)) mark(entry)
        }
      }
      if (changed) await this.save(marks)
      await this.state.setMeta?.(SCOPE_KEY, JSON.stringify(scope))
    })
  }

  /**
   * Mark what the scope excludes now, and settle what has come back into it. Every entry is
   * read — as the scan reads them all anyway — and the disk is asked only about the few that
   * were marked and are back in scope.
   */
  review(fs: FileSystem, filter: ScanFilter): Promise<ScopeReview> {
    return serially(this.state, () => this.reviewNow(fs, filter))
  }

  private async reviewNow(fs: FileSystem, filter: ScanFilter): Promise<ScopeReview> {
    const marks = await this.load()
    const review: ScopeReview = { forgotten: [], recheck: new Set() }
    const live = new Set<string>()
    let changed = false
    let rewound = false
    for (const entry of await this.entries()) {
      if (isEngineOwn(entry.wirePath)) continue
      live.add(entry.fileId)
      if (filter.excluded(entry.wirePath, entry.size)) {
        if (!marks.has(entry.fileId)) {
          marks.add(entry.fileId)
          changed = true
        }
        continue
      }
      if (!marks.has(entry.fileId)) continue
      if ((await fs.stat(entry.path)) === null) {
        // Rewind first, then forget: killed between the two, a rewound feed with the entry
        // still here only costs a walk, while a dropped entry with the cursor past the file's
        // last change would leave it missing here with nothing to bring it.
        if (!rewound) {
          await this.state.setCursor(0)
          rewound = true
        }
        await this.state.delete(entry.path)
        marks.delete(entry.fileId)
        changed = true
        review.forgotten.push(entry.wirePath)
      } else {
        review.recheck.add(entry.fileId)
      }
    }
    for (const id of [...marks]) {
      if (live.has(id)) continue
      marks.delete(id)
      changed = true
    }
    if (changed) await this.save(marks)
    return review
  }

  /** The files a finished manifest walk has confirmed or taken: back to being read as usual. */
  settle(fileIds: Iterable<string>): Promise<void> {
    return serially(this.state, async () => {
      const marks = await this.load()
      let changed = false
      for (const id of fileIds) changed = marks.delete(id) || changed
      if (changed) await this.save(marks)
    })
  }

  /** Every entry, read to the end before anything is dropped: a store may not take a write mid-iteration. */
  private async entries(): Promise<StateEntry[]> {
    const entries: StateEntry[] = []
    for await (const entry of this.state.all()) entries.push(entry)
    return entries
  }

  /** Read afresh each time: another engine over the same state may have filed some since. */
  private async load(): Promise<Set<string>> {
    if (!this.state.getMeta) return (this.memory ??= new Set())
    return new Set(parse(await this.state.getMeta(MARKS_KEY)))
  }

  private async save(marks: Set<string>): Promise<void> {
    if (!this.state.setMeta) return
    await this.state.setMeta(MARKS_KEY, marks.size === 0 ? null : JSON.stringify([...marks]))
  }
}

/** The filter a filed scope stood for. */
function filterOf(scope: ScopeRecord): ScanFilter {
  const rules = typeof scope.ignore === 'string' ? IgnoreRules.parse(scope.ignore) : null
  return {
    excluded: (path, size) =>
      isExcluded(path, size, scope.selective, scope.scriptsFolder) ||
      (rules?.ignores(path) ?? false),
  }
}

/** A filed scope, or null when it cannot be read as one. */
function parseRecord(raw: string): ScopeRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ScopeRecord> | null
    if (value === null || typeof value !== 'object') return null
    const selective = value.selective
    if (typeof selective !== 'object' || selective === null) return null
    if (typeof value.scriptsFolder !== 'string') return null
    if (!Array.isArray(selective.excludedFolders) || typeof selective.settings !== 'object') {
      return null
    }
    return value as ScopeRecord
  } catch {
    return null
  }
}

/** The same scope, spelled the same whatever order its keys were built in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** The filed marks, or none when there are none or they cannot be read. */
function parse(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

const ASIDE_KEY = 'passed-over-paths'

/**
 * Paths where the pull passed a server file over because a local file this device does not
 * sync — over its cap — lay there. The feed moved past that change, so once the local file is
 * gone nothing would bring the server's file: a path whose local file has gone asks for a
 * manifest walk, and is forgotten. A local file that shrank back into
 * scope is forgotten too: the scan sends it, and the server settles the two. Filed in the state
 * beside the scope marks; nothing here asks the server anything.
 */
export class AsideMarks {
  /** For a store that cannot file them: kept for as long as this engine lives. */
  private memory: Map<string, string> | null = null

  constructor(private readonly state: StateStore) {}

  /**
   * Disk path → wire path, for every path a pull passed over. The puller waits for it before
   * it moves the cursor past the change, so a mark is never missing for a change passed.
   */
  add(paths: Map<string, string>): Promise<void> {
    if (paths.size === 0) return Promise.resolve()
    return serially(this.state, async () => {
      const marks = await this.load()
      let changed = false
      for (const [path, wire] of paths) {
        if (marks.get(path) === wire) continue
        marks.set(path, wire)
        changed = true
      }
      if (changed) await this.save(marks)
    })
  }

  /**
   * Whether a path's local file has gone, so a walk is due; settled paths are forgotten. A due
   * walk rewinds the cursor here, before a mark is forgotten: killed between the two, a rewound
   * feed with the mark still filed only costs a walk, while a forgotten mark with the cursor
   * still past the change would leave the server's file missing here.
   */
  due(fs: FileSystem, filter: ScanFilter): Promise<boolean> {
    return serially(this.state, async () => {
      const marks = await this.load()
      if (marks.size === 0) return false
      let walk = false
      let changed = false
      for (const [path, wire] of [...marks]) {
        const have = await fs.stat(path)
        if (have !== null && filter.excluded(wire, have.size)) continue
        if (have === null) walk = true
        marks.delete(path)
        changed = true
      }
      if (walk) await this.state.setCursor(0)
      if (changed) await this.save(marks)
      return walk
    })
  }

  private async load(): Promise<Map<string, string>> {
    if (!this.state.getMeta) return (this.memory ??= new Map())
    const raw = await this.state.getMeta(ASIDE_KEY)
    if (raw === null) return new Map()
    try {
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null) return new Map()
      return new Map(
        Object.entries(value).filter(
          (pair): pair is [string, string] => typeof pair[1] === 'string'
        )
      )
    } catch {
      return new Map()
    }
  }

  private async save(marks: Map<string, string>): Promise<void> {
    if (!this.state.setMeta) return
    await this.state.setMeta(
      ASIDE_KEY,
      marks.size === 0 ? null : JSON.stringify(Object.fromEntries(marks))
    )
  }
}
