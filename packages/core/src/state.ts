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
  batchId: string
  ops: CommitOp[]
  idempotencyKey: string
  startedAt: string
  /** Stable original op indices when owner preflight holds part of a unit. */
  ownerBinding?: { issuer: string; vaultId: string; credentialFingerprint: string }
  publicationPhase?: 'prepared' | 'submitted'
  operationIndices?: number[]
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
  /** All or nothing: memory snapshots and rolls back, SQLite runs BEGIN/COMMIT. */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  /**
   * A string the engine keeps beside the entries, by key; null when there is none. Optional:
   * a store without it still syncs, and the engine keeps what it would have filed in memory,
   * for as long as the process lives. Both hosts' stores have it.
   */
  getMeta?(key: string): Promise<string | null> | string | null
  /** Files a string under `key`, or removes the key for `null`. */
  setMeta?(key: string, value: string | null): Promise<void> | void
}

interface Contents {
  entries: Map<string, StateEntry>
  index: Map<string, string>
  cursor: number
  journal: Journal | null
  meta: Map<string, string>
}

/**
 * A `StateStore` over `Map`s, for the engine's tests.
 *
 * Entries are copied in and out, so the store owns what it holds. `transaction` snapshots the
 * whole contents and restores them if the callback throws, which is what lets the engine treat
 * "clear the journal and record its results" as one step even in memory.
 */
export class MemoryStateStore implements StateStore {
  /** Keyed by path. */
  private entries = new Map<string, StateEntry>()
  /** fileId → the path that file was last put under. */
  private index = new Map<string, string>()
  private cursor = 0
  private journal: Journal | null = null
  private meta = new Map<string, string>()

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
    this.entries.set(entry.path, { ...entry })
    this.index.set(entry.fileId, entry.path)
  }

  async delete(path: string): Promise<void> {
    const entry = this.entries.get(path)
    if (!entry) return
    this.entries.delete(path)
    // Only drop the index if it still points here: a moved file indexes its new path.
    if (this.index.get(entry.fileId) === path) this.index.delete(entry.fileId)
  }

  async getCursor(): Promise<number> {
    return this.cursor
  }

  async setCursor(seq: number): Promise<void> {
    this.cursor = seq
  }

  async getJournal(): Promise<Journal | null> {
    return copyJournal(this.journal)
  }

  async setJournal(j: Journal | null): Promise<void> {
    this.journal = copyJournal(j)
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) this.meta.delete(key)
    else this.meta.set(key, value)
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.contents()
    try {
      return await fn()
    } catch (error) {
      this.restore(before)
      throw error
    }
  }

  private contents(): Contents {
    return {
      entries: new Map(this.entries),
      index: new Map(this.index),
      cursor: this.cursor,
      journal: copyJournal(this.journal),
      meta: new Map(this.meta),
    }
  }

  private restore(contents: Contents): void {
    this.entries = contents.entries
    this.index = contents.index
    this.cursor = contents.cursor
    this.journal = contents.journal
    this.meta = contents.meta
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
        ...(j.operationIndices ? { operationIndices: [...j.operationIndices] } : {}),
      }
    : null
