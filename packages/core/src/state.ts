import type { CommitOp } from '@abele/sync-protocol'

/** What the engine remembers about one synced file between runs. */
export interface StateEntry {
  /** On-disk form, as the host spells it. */
  path: string
  /** NFC form, as the wire spells it. */
  wirePath: string
  fileId: string
  versionId: string
  sha: string
  size: number
  mtime: number
}

/** A commit in flight. Written before the request, cleared once its results are recorded. */
export interface Journal {
  /** Namespace and feed position where this core instance authored the immutable request. */
  origin?: { generation: string | null; cursor: number }
  batchId: string
  ops: CommitOp[]
  idempotencyKey: string
  startedAt: string
}

/**
 * Durable engine state. The plugin implements this over its data file, the daemon over SQLite;
 * the engine and its tests use `MemoryStateStore`.
 */
export interface StateStore {
  /** Optional host claim attribution for durable in-flight installation intents. */
  effectOwner?(): string | undefined
  get(path: string): Promise<StateEntry | null>
  byFileId(fileId: string): Promise<StateEntry | null>
  all(): AsyncIterable<StateEntry>
  /** Upserts by `path` and indexes `fileId`. */
  put(entry: StateEntry): Promise<void>
  delete(path: string): Promise<void>
  getCursor(): Promise<number>
  setCursor(seq: number): Promise<void>
  getJournal(): Promise<Journal | null>
  setJournal(j: Journal | null): Promise<void>
  /** All or nothing: memory logs rollback mutations, SQLite runs BEGIN/COMMIT. */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  /**
   * A string the engine keeps beside the entries, by key; null when there is none. Optional:
   * a store without it still syncs, and the engine keeps what it would have filed in memory,
   * for as long as the process lives. Both hosts' stores have it.
   */
  getMeta?(key: string): Promise<string | null> | string | null
  /** Files a string under `key`, or removes the key for `null`. */
  setMeta?(key: string, value: string | null): Promise<void> | void
  /** Enumerate durable intent keys when retiring authority after a server restore. */
  metadataKeys?(prefix: string): string[] | Promise<string[]>
}

/**
 * A `StateStore` over `Map`s, for the engine's tests.
 *
 * Entries are copied in and out, so the store owns what it holds. Transactions log
 * mutations for rollback; a cursor update never copies the rest of a large vault.
 */
export class MemoryStateStore implements StateStore {
  /** Keyed by path. */
  private entries = new Map<string, StateEntry>()
  /** fileId → the path that file was last put under. */
  private index = new Map<string, string>()
  private cursor = 0
  private journal: Journal | null = null
  private meta = new Map<string, string>()
  private readonly undo: (() => void)[][] = []

  private remember(restore: () => void): void {
    for (const frame of this.undo) frame.push(restore)
  }

  private change<K, V>(map: Map<K, V>, key: K, value: V | undefined): void {
    const before = map.get(key)
    this.remember(() => {
      if (before === undefined) map.delete(key)
      else map.set(key, before)
    })
    if (value === undefined) map.delete(key)
    else map.set(key, value)
  }

  async get(path: string): Promise<StateEntry | null> {
    const entry = this.entries.get(path)
    return entry ? { ...entry } : null
  }

  async byFileId(fileId: string): Promise<StateEntry | null> {
    const path = this.index.get(fileId)
    return path === undefined ? null : this.get(path)
  }

  async *all(): AsyncIterable<StateEntry> {
    for (const entry of [...this.entries.values()]) yield { ...entry }
  }

  /**
   * Upserts by `path` and points `fileId` at it. A file put under a new path leaves its old
   * entry behind — a move is a `put` of the new path followed by a `delete` of the old one,
   * and the caller does both.
   */
  async put(entry: StateEntry): Promise<void> {
    this.change(this.entries, entry.path, { ...entry })
    this.change(this.index, entry.fileId, entry.path)
  }

  async delete(path: string): Promise<void> {
    const entry = this.entries.get(path)
    if (!entry) return
    this.change(this.entries, path, undefined)
    // Only drop the index if it still points here: a moved file indexes its new path.
    if (this.index.get(entry.fileId) === path) this.change(this.index, entry.fileId, undefined)
  }

  async getCursor(): Promise<number> {
    return this.cursor
  }

  async setCursor(seq: number): Promise<void> {
    const before = this.cursor
    this.remember(() => {
      this.cursor = before
    })
    this.cursor = seq
  }

  async getJournal(): Promise<Journal | null> {
    return copyJournal(this.journal)
  }

  async setJournal(j: Journal | null): Promise<void> {
    const before = this.journal
    this.remember(() => {
      this.journal = before
    })
    this.journal = copyJournal(j)
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null
  }
  metadataKeys(prefix: string): string[] {
    return [...this.meta.keys()].filter((key) => key.startsWith(prefix))
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    this.change(this.meta, key, value ?? undefined)
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const frame: (() => void)[] = []
    this.undo.push(frame)
    try {
      return await fn()
    } catch (error) {
      for (let n = frame.length - 1; n >= 0; n--) frame[n]!()
      throw error
    } finally {
      this.undo.splice(this.undo.indexOf(frame), 1)
    }
  }
}

/**
 * A journal the caller and the store don't share. `ops` is copied too: the engine appends to an
 * open journal in place, and without this a failed `transaction` would roll back everything
 * except that append. The `CommitOp`s themselves are plain data nobody rewrites.
 */
const copyJournal = (j: Journal | null): Journal | null =>
  j
    ? {
        ...j,
        ops: [...j.ops],
      }
    : null
