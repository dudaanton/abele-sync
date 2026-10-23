import type { CommitOp } from '@abele/sync-protocol'
import { caseKey } from '@abele/sync-protocol'
import { StateTransaction, changedState, type StateMutation } from './stateTransaction.js'

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
 * Durable engine state. Hosts implement this over IndexedDB or SQLite;
 * the engine and its tests use `MemoryStateStore`.
 */
export interface StateStore {
  /** True only when transaction passes an isolated, revocable capability. */
  readonly transactionScoped?: boolean
  /** Transaction capabilities may register in-memory acknowledgements with their
   * durable owner. Nested success transfers callbacks; rollback discards them.
   * Hosts without this port must reload owners after commit. */
  afterCommit?(acknowledge: () => void): void
  /** Optional host claim attribution for durable in-flight installation intents. */
  effectOwner?(): string | undefined
  get(path: string): Promise<StateEntry | null>
  byFileId(fileId: string): Promise<StateEntry | null>
  all(): AsyncIterable<StateEntry>
  /** All rows with equal host keys, including exact spelling. The key is stable
   * for an adapter lifetime; default is protocol caseKey for legacy callers.
   * An index must use the supplied key, never a narrower prefilter. */
  pathCandidates?(path: string, key?: (path: string) => string): AsyncIterable<StateEntry>
  /** Upserts by `path` and indexes `fileId`. */
  put(entry: StateEntry): Promise<void>
  delete(path: string): Promise<void>
  getCursor(): Promise<number>
  setCursor(seq: number): Promise<void>
  getJournal(): Promise<Journal | null>
  setJournal(j: Journal | null): Promise<void>
  /** All callback reads/writes MUST use tx, including helpers called after awaits.
   * Root calls belong to unrelated tasks and must survive rollback. Do not retain tx.
   * See transact() for the exclusive-access compatibility path for legacy hosts. */
  transaction<T>(fn: (tx: StateStore) => Promise<T>): Promise<T>
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
 * Entries are copied in and out. Transactions own private patches and publish them
 * synchronously on success; a cursor update never copies the rest of a large vault.
 */
export class MemoryStateStore implements StateStore {
  readonly transactionScoped = true
  private revision = 0
  /** Keyed by path. */
  private entries = new Map<string, StateEntry>()
  private paths = new Map<string, Set<string>>()
  private indexedPaths = new Map<string, string>()
  private dirtyPaths = new Set<string>()
  private pathIndexKey: (path: string) => string = caseKey
  /** fileId → the path that file was last put under. */
  private index = new Map<string, string>()
  private cursor = 0
  private journal: Journal | null = null
  private meta = new Map<string, string>()

  private change<K, V>(map: Map<K, V>, key: K, value: V | undefined): void {
    this.revision++
    if (map === this.entries) {
      const path = key as string,
        folded = this.indexedPaths.get(path)
      if (folded !== undefined) {
        const names = this.paths.get(folded)!
        names.delete(path)
        if (!names.size) this.paths.delete(folded)
        this.indexedPaths.delete(path)
      }
      this.dirtyPaths.delete(path)
      if (value !== undefined) this.dirtyPaths.add(path)
    }
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

  async *pathCandidates(path: string, key = caseKey): AsyncIterable<StateEntry> {
    if (key !== this.pathIndexKey) {
      const paths = new Map<string, Set<string>>(),
        indexed = new Map<string, string>()
      for (const name of this.entries.keys()) {
        const folded = key(name),
          names = paths.get(folded) ?? new Set<string>()
        names.add(name)
        paths.set(folded, names)
        indexed.set(name, folded)
      }
      this.pathIndexKey = key
      this.paths = paths
      this.indexedPaths = indexed
      this.dirtyPaths.clear()
    }
    // Never invoke an old host capability during state publication. After a
    // restart it may be revoked; only the current read supplies a live key.
    for (const name of this.dirtyPaths) {
      const folded = key(name),
        names = this.paths.get(folded) ?? new Set<string>()
      names.add(name)
      this.paths.set(folded, names)
      this.indexedPaths.set(name, folded)
    }
    this.dirtyPaths.clear()
    for (const name of this.paths.get(key(path)) ?? []) {
      const entry = await this.get(name)
      if (entry !== null) yield entry
    }
  }

  /**
   * Upserts by `path` and points `fileId` at it. A file put under a new path leaves its old
   * entry behind — a move is a `put` of the new path followed by a `delete` of the old one,
   * and the caller does both.
   */
  async put(entry: StateEntry): Promise<void> {
    this.apply({ kind: 'put', entry })
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
    this.revision++
    this.cursor = seq
  }

  async getJournal(): Promise<Journal | null> {
    return copyJournal(this.journal)
  }

  async setJournal(j: Journal | null): Promise<void> {
    this.revision++
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

  /** Capture a host fence before awaiting work; check it at synchronous publication.
   * Simulated process stores revoke pending patches when their epoch is abandoned. */
  protected publicationFence(): () => void {
    return () => {}
  }

  async transaction<T>(fn: (tx: StateStore) => Promise<T>): Promise<T> {
    const fence = this.publicationFence()
    const revision = this.revision
    const tx = new StateTransaction(this)
    try {
      const result = await fn(tx)
      fence()
      if (revision !== this.revision) throw changedState()
      // Publication is synchronous: no unrelated task can interleave patch mutations.
      for (const op of tx.mutations) this.apply(op)
      tx.acknowledgeCommit()
      return result
    } finally {
      tx.close()
    }
  }

  private apply(op: StateMutation): void {
    switch (op.kind) {
      case 'put': {
        const displaced = this.entries.get(op.entry.path)
        if (
          displaced &&
          displaced.fileId !== op.entry.fileId &&
          this.index.get(displaced.fileId) === op.entry.path
        )
          this.change(this.index, displaced.fileId, undefined)
        this.change(this.entries, op.entry.path, { ...op.entry })
        this.change(this.index, op.entry.fileId, op.entry.path)
        break
      }
      case 'delete': {
        const entry = this.entries.get(op.path)
        this.change(this.entries, op.path, undefined)
        if (entry && this.index.get(entry.fileId) === op.path)
          this.change(this.index, entry.fileId, undefined)
        break
      }
      case 'cursor':
        this.revision++
        this.cursor = op.value
        break
      case 'journal':
        this.revision++
        this.journal = copyJournal(op.value)
        break
      case 'meta':
        this.change(this.meta, op.key, op.value ?? undefined)
        break
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
