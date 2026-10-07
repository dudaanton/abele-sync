import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import { Kysely, PostgresDialect, SqliteAdapter, SqliteDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './schema.js'

export type Dialect = 'sqlite' | 'pg'

export interface Db {
  db: Kysely<Database>
  dialect: Dialect
  close(): Promise<void>
}

const SQLITE_MEMORY_URL = 'sqlite::memory:'
const SQLITE_PREFIX = 'sqlite://'
const MEMORY = ':memory:'

/** Open a database from a connection URL. SQLite is a file or `:memory:`; Postgres is a pool. */
export function createDb(url: string): Db {
  if (url === SQLITE_MEMORY_URL || url.startsWith(SQLITE_PREFIX)) return createSqliteDb(url)
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return createPostgresDb(url)
  throw new Error(`unsupported database url: ${url}`)
}

/** Inspection must not turn a mistyped SQLite path into a fresh database or change
 * its journal mode. The driver's read-only/file-must-exist flags also close the
 * existence-check/open race. PostgreSQL inspection callers execute read queries only.
 */
export function openInspectionDb(url: string): Db {
  if (url.startsWith(SQLITE_PREFIX)) {
    const file = url.slice(SQLITE_PREFIX.length)
    if (file === '' || file === MEMORY)
      throw new Error('inspection requires an existing SQLite file')
    const sqlite = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
    const db = new Kysely<Database>({
      dialect: new TransactionalSqliteDialect({ database: sqlite }),
    })
    return { db, dialect: 'sqlite', close: () => db.destroy() }
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return createPostgresDb(url)
  throw new Error('inspection requires an existing database')
}

/** SQLite supports transactional DDL. Include DDL/copies and the migration journal in
 * Kysely's one transaction, rather than its stock adapter's non-atomic migration path.
 */
class TransactionalSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true
  }
}
class TransactionalSqliteDialect extends SqliteDialect {
  override createAdapter(): TransactionalSqliteAdapter {
    return new TransactionalSqliteAdapter()
  }
}

function createSqliteDb(url: string): Db {
  const file = url === SQLITE_MEMORY_URL ? MEMORY : url.slice(SQLITE_PREFIX.length)
  if (file === '') throw new Error(`unsupported database url: ${url}`)
  if (file !== MEMORY) {
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`cannot create directory for ABELE_DATABASE_URL ${url}: ${message}`, {
        cause,
      })
    }
  }

  const sqlite = new SqliteDatabase(file)
  // WAL is meaningless for an in-memory database and better-sqlite3 warns about it.
  if (file !== MEMORY) sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')

  const db = new Kysely<Database>({ dialect: new TransactionalSqliteDialect({ database: sqlite }) })
  return { db, dialect: 'sqlite', close: () => db.destroy() }
}

/** Postgres's type oid for `bigint` (`int8`). */
const INT8_OID = 20

/**
 * node-pg returns `bigint` as a string, because not every one fits a JS number.
 * The ones this schema holds do — epoch milliseconds, byte counts, sequence
 * numbers and `count(*)` are all far below 2^53 — and every reader expects a
 * number, so they come back as numbers. One that did not fit would be silently
 * rounded; it is refused instead.
 */
export function parseInt8(value: string): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new Error(`bigint ${value} does not fit a number`)
  return n
}

/** The driver's own parsers, but with `bigint` read as a number — for this pool only. */
const pgTypes = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === INT8_OID && format !== 'binary'
      ? parseInt8
      : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
}

function createPostgresDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, types: pgTypes })
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  return { db, dialect: 'pg', close: () => db.destroy() }
}
