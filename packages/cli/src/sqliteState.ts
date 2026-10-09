import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import SqliteDatabase, { type Database, type Statement } from 'better-sqlite3'
import {
  EngineError,
  ExternalStateError,
  SqliteExternalStateStore,
  type ExternalPhaseBatch,
  type ExternalStatePort,
  type Journal,
  type StateEntry,
  type StateStore,
} from '@abele/sync-core'

const SCHEMA = `
create table if not exists entries (
  path text primary key,
  wire_path text not null unique,
  file_id text not null unique,
  version_id text not null,
  sha text not null,
  size integer not null,
  mtime integer not null
);
create table if not exists meta (
  key text primary key,
  value text not null
);
`

const CURSOR_KEY = 'cursor'
const JOURNAL_KEY = 'journal'
/** How long a statement waits for another writer before it gives up. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000

export interface SqliteStateStoreOptions {
  /** The daemon takes the default; a test lowers it to provoke a lock without waiting for one. */
  busyTimeoutMs?: number
  /** Host ownership/binding/generation check at actual ledger effects, including COMMIT. */
  effectGuard?: () => void
  effectOwner?: () => string | undefined
}

interface Row {
  path: string
  wire_path: string
  file_id: string
  version_id: string
  sha: string
  size: number
  mtime: number
}

/**
 * The daemon's state, in SQLite.
 *
 * Three keys index one row: `path` is what it is stored under, and `file_id` and `wire_path` are
 * unique. That is stricter than `MemoryStateStore`, where a file put under a new path leaves its
 * old row behind for the caller to delete — here `put` clears any other row holding the same
 * `file_id` or `wire_path` first, so the caveat the memory store documents cannot happen and a
 * crash between the put and the delete cannot leave two rows claiming one file.
 *
 * better-sqlite3 is synchronous, so every method resolves without ever yielding the loop; the
 * `async` signatures are the `StateStore` contract, not a promise of concurrency. Ordinary ledger
 * calls wrap driver errors as `EngineError`: a locked database is `'conflict'` (retry later), and
 * anything else — a closed connection, a corrupt file — is `'io'`. External phase calls use the
 * shared port's `ExternalStateError` semantics, including aborted and unknown commit outcomes.
 */
export class SqliteStateStore implements StateStore, ExternalStatePort {
  readonly externalDurability = 'durable' as const
  /** One shared adapter over this exact connection, retaining unknown-outcome holds.
   * Lazy creation leaves ordinary memory stores and read-only snapshots unchanged.
   */
  private external: SqliteExternalStateStore | undefined
  private readonly selectByPath: Statement
  private readonly selectByFileId: Statement
  private readonly selectAll: Statement
  private readonly clearClashes: Statement
  private readonly upsert: Statement
  private readonly deleteByPath: Statement
  private readonly selectMeta: Statement
  private readonly upsertMeta: Statement
  private readonly deleteMeta: Statement
  /** 0 outside a transaction; a nested `transaction` runs inside the outer one. */
  private depth = 0

  private readonly openedIdentity: string | undefined
  private constructor(
    private readonly db: Database,
    private readonly effectGuard?: () => void,
    private readonly openedFile?: string,
    private readonly pullOwner?: () => string | undefined
  ) {
    if (openedFile && openedFile !== ':memory:') {
      const stat = lstatSync(openedFile, { bigint: true })
      this.openedIdentity = `${stat.dev}:${stat.ino}`
    }
    this.selectByPath = db.prepare('select * from entries where path = ?')
    this.selectByFileId = db.prepare('select * from entries where file_id = ?')
    this.selectAll = db.prepare('select * from entries')
    this.clearClashes = db.prepare(
      'delete from entries where path <> ? and (file_id = ? or wire_path = ?)'
    )
    this.upsert = db.prepare(
      `insert into entries (path, wire_path, file_id, version_id, sha, size, mtime)
       values (@path, @wire_path, @file_id, @version_id, @sha, @size, @mtime)
       on conflict(path) do update set
         wire_path = excluded.wire_path, file_id = excluded.file_id,
         version_id = excluded.version_id, sha = excluded.sha,
         size = excluded.size, mtime = excluded.mtime`
    )
    this.deleteByPath = db.prepare('delete from entries where path = ?')
    this.selectMeta = db.prepare('select value from meta where key = ?')
    this.upsertMeta = db.prepare(
      'insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
    )
    this.deleteMeta = db.prepare('delete from meta where key = ?')
  }

  /** Opens (and creates) the database file, its folder and its schema. */
  static open(file: string, options: SqliteStateStoreOptions = {}): SqliteStateStore {
    options.effectGuard?.()
    try {
      mkdirSync(dirname(file), { recursive: true })
      const db = new SqliteDatabase(file)
      // WAL so a reader never blocks the sync loop; the timeout covers the moments one does.
      db.pragma('journal_mode = WAL')
      db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`)
      db.exec(SCHEMA)
      return new SqliteStateStore(db, options.effectGuard, file, options.effectOwner)
    } catch (cause) {
      throw new EngineError('io', `cannot open the state database at ${file}`, cause)
    }
  }

  /** Existing ledger only: no mkdir, schema writes or BEGIN IMMEDIATE. The
   * deferred read transaction pins one committed WAL snapshot until close.
   */
  static openReadOnlySnapshot(file: string): SqliteStateStore {
    let db: Database | undefined
    try {
      db = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
      db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`)
      db.exec('BEGIN')
      const store = new SqliteStateStore(db, undefined, file)
      // ScopedState.open validates through transaction(); keep its reads inside
      // this snapshot instead of asking for the writer reservation.
      store.depth = 1
      return store
    } catch (cause) {
      db?.close()
      throw new EngineError('io', `cannot read the state database at ${file}`, cause)
    }
  }

  close(): void {
    guard('cannot close the state database', () => this.db.close())
  }

  private externalPort(): SqliteExternalStateStore {
    const db = this.db
    return (this.external ??= new SqliteExternalStateStore({
      get inTransaction() {
        return db.inTransaction
      },
      exec: (sql) => {
        if (sql !== 'ROLLBACK') this.checkEffect()
        return db.exec(sql)
      },
      prepare: (sql) => {
        const statement = db.prepare<(string | number | null)[]>(sql)
        return {
          get: (...parameters) => statement.get(...parameters),
          run: (...parameters) => {
            this.checkEffect()
            return statement.run(...parameters)
          },
        }
      },
    }))
  }

  assertExternalEffectsAllowed(): void {
    this.externalPort().assertExternalEffectsAllowed()
  }

  async getExternalState(): Promise<string | null> {
    return this.externalPort().getExternalState()
  }

  async commitExternalPhase(batch: ExternalPhaseBatch): Promise<void> {
    // Never use transaction(): its supported legacy nesting could return an
    // external effect receipt before the outer ledger transaction commits.
    return this.externalPort().commitExternalPhase(batch)
  }

  async get(path: string): Promise<StateEntry | null> {
    return guard(`cannot read the state of ${path}`, () =>
      toEntry(this.selectByPath.get(path) as Row | undefined)
    )
  }

  async byFileId(fileId: string): Promise<StateEntry | null> {
    return guard(`cannot read the state of ${fileId}`, () =>
      toEntry(this.selectByFileId.get(fileId) as Row | undefined)
    )
  }

  async *all(): AsyncIterable<StateEntry> {
    // Read every row up front: the caller may await between steps, and a statement left open
    // across an await would hold its read while the loop runs something else.
    const rows = guard('cannot read the state', () => this.selectAll.all() as Row[])
    for (const row of rows) yield toRequiredEntry(row)
  }

  async put(entry: StateEntry): Promise<void> {
    this.write(`cannot record ${entry.path}`, () => {
      this.clearClashes.run(entry.path, entry.fileId, entry.wirePath)
      this.upsert.run({
        path: entry.path,
        wire_path: entry.wirePath,
        file_id: entry.fileId,
        version_id: entry.versionId,
        sha: entry.sha,
        size: entry.size,
        mtime: entry.mtime,
      })
    })
  }

  async delete(path: string): Promise<void> {
    this.checkEffect()
    guard(`cannot forget ${path}`, () => this.deleteByPath.run(path))
  }

  async getCursor(): Promise<number> {
    const value = this.meta(CURSOR_KEY)
    return value === null ? 0 : Number(value)
  }

  async setCursor(seq: number): Promise<void> {
    this.checkEffect()
    guard('cannot record the cursor', () => this.upsertMeta.run(CURSOR_KEY, String(seq)))
  }

  async getJournal(): Promise<Journal | null> {
    const value = this.meta(JOURNAL_KEY)
    if (value === null) return null
    // Parsing builds a fresh object every time, so no caller can reach the stored journal. A
    // row that does not parse is a damaged database, which is an `io` like any other.
    return guard('cannot read the journal', () => JSON.parse(value) as Journal)
  }

  async setJournal(j: Journal | null): Promise<void> {
    this.checkEffect()
    guard('cannot record the journal', () =>
      j === null
        ? this.deleteMeta.run(JOURNAL_KEY)
        : this.upsertMeta.run(JOURNAL_KEY, JSON.stringify(j))
    )
  }

  /**
   * What the daemon itself remembers between runs, beside the engine's cursor and journal:
   * one string under one key, or `null` when nothing was written under it. The cursor and
   * the journal have their own accessors and cannot be reached through here.
   */
  effectOwner(): string | undefined { return this.pullOwner?.() }

  metadataKeys(prefix: string): string[] {
    const name = own(prefix)
    const rows = guard('cannot inspect ledger metadata keys', () =>
      this.db.prepare('SELECT key FROM meta WHERE substr(key, 1, ?) = ?').all(name.length, name)
    ) as { key: string }[]
    return rows.map((row) => row.key.slice('daemon:'.length))
  }

  getMeta(key: string): string | null {
    return this.meta(own(key))
  }

  setMeta(key: string, value: string | null): void {
    this.checkEffect()
    const name = own(key)
    guard(`cannot record ${name}`, () =>
      value === null ? this.deleteMeta.run(name) : this.upsertMeta.run(name, value)
    )
  }

  /**
   * `BEGIN IMMEDIATE` … `COMMIT`, `ROLLBACK` if the callback throws. Nesting is counted, not
   * saved: an inner `transaction` is part of the outer one and does not commit on its own, so
   * an inner throw the caller swallows leaves its writes in the outer transaction — the engine
   * lets every failure out, which is what makes that safe.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.checkEffect()
    if (this.depth > 0) {
      this.depth++
      try {
        return await fn()
      } finally {
        this.depth--
      }
    }
    guard('cannot begin a state transaction', () => this.db.exec('BEGIN IMMEDIATE'))
    this.depth = 1
    try {
      const result = await fn()
      this.checkEffect()
      guard('cannot commit the state transaction', () => this.db.exec('COMMIT'))
      return result
    } catch (error) {
      // A failed COMMIT may have rolled back already; that ROLLBACK must not hide the error.
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* no transaction left to roll back */
      }
      throw error
    } finally {
      this.depth = 0
    }
  }

  /** Two statements that have to land together, whether or not a transaction is already open. */
  private write(what: string, fn: () => void): void {
    this.checkEffect()
    guard(what, () => (this.depth > 0 ? fn() : this.db.transaction(fn)()))
  }

  private checkEffect(): void {
    this.effectGuard?.()
  }

  /** The private handle must still be the physical ledger named by its descriptor. */
  isLedgerFile(file: string): boolean {
    if (!this.db.open || !this.openedFile || !this.openedIdentity) return false
    try {
      const stat = lstatSync(file, { bigint: true })
      return (
        realpathSync(file) === realpathSync(this.openedFile) &&
        `${stat.dev}:${stat.ino}` === this.openedIdentity
      )
    } catch {
      return false
    }
  }

  /** Inspection never creates a new identity in a missing/replaced activated ledger. */
  readExternalInstanceId(): string | null {
    const id = this.meta(own('ledger-instance-id'))
    if (id !== null && !/^[0-9a-f-]{36}$/.test(id))
      throw new ExternalStateError('recovery-required')
    return id
  }
  getExternalInstanceId(): string {
    this.externalPort() // Refuse SQLite memory as production persistence.
    if (this.db.inTransaction) throw new ExternalStateError('nested-transaction')
    const existing = this.readExternalInstanceId()
    if (existing !== null) return existing
    this.checkEffect()
    guard('cannot initialize ledger instance identity', () =>
      this.db.transaction(() => {
        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
          .run(own('ledger-instance-id'), randomUUID())
      })()
    )
    return this.readExternalInstanceId()!
  }

  private meta(key: string): string | null {
    const row = guard(`cannot read ${key}`, () => this.selectMeta.get(key)) as
      { value: string } | undefined
    return row === undefined ? null : row.value
  }
}

/** A daemon key, kept clear of the engine's two: `daemon:<key>`. */
const own = (key: string): string => `daemon:${key}`

/**
 * Every call into better-sqlite3 goes through here. A database another writer holds is a
 * `'conflict'` the daemon can retry; a connection that is closed, a file that is corrupt or a
 * disk that is full is an `'io'`.
 */
function guard<T>(what: string, fn: () => T): T {
  try {
    return fn()
  } catch (cause) {
    const code =
      typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined
    if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) {
      throw new EngineError('conflict', `${what}: the state database is locked`, cause)
    }
    throw new EngineError('io', what, cause)
  }
}

const toEntry = (row: Row | undefined): StateEntry | null =>
  row === undefined ? null : toRequiredEntry(row)

const toRequiredEntry = (row: Row): StateEntry => ({
  path: row.path,
  wirePath: row.wire_path,
  fileId: row.file_id,
  versionId: row.version_id,
  sha: row.sha,
  size: row.size,
  mtime: row.mtime,
})
