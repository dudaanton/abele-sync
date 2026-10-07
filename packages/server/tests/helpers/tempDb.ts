import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { createDb, type Db, type Dialect } from '../../src/db/connect.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Database } from '../../src/db/schema.js'

/** How a fresh database is brought up; a test of the migrations themselves stops short. */
type Migrate = (db: Kysely<Database>, schema?: string) => Promise<void>

/** A test database; on Postgres, `schema` is the one it lives in, to hand back to `runMigrations`. */
export type TempDb = Db & { schema?: string; url?: string }

/** The Postgres a developer points the suite at, or empty when there is none. */
export const PG_TEST_URL = process.env.ABELE_TEST_PG_URL ?? ''

/** Whether the Postgres-only tests can run here; `describe.skipIf(!hasPgTestDb)` reads it. */
export const hasPgTestDb = PG_TEST_URL !== ''
if (process.env.ABELE_REQUIRE_PG === '1' && !hasPgTestDb) {
  throw new Error('ABELE_TEST_PG_URL is required; the SQL gate cannot skip PostgreSQL')
}

/**
 * A migrated database for a test to work on. By default that is SQLite in
 * memory, which needs nothing installed; `tempDb('pg')` is the same database on
 * the server `ABELE_TEST_PG_URL` names, and is only reachable from a test that
 * skipped itself when the variable is unset.
 */
export async function tempDb(
  dialect: Dialect = 'sqlite',
  migrate: Migrate = runMigrations
): Promise<TempDb> {
  if (dialect === 'pg') return tempPgDb(migrate)
  const handle = createDb('sqlite::memory:')
  await migrate(handle.db)
  return handle
}

/** The database this test file works in, created on first use; see `fileDatabaseUrl`. */
let fileDatabase: Promise<string> | undefined

/**
 * A database of this test file's own on the server `ABELE_TEST_PG_URL` names, so the role there
 * needs CREATEDB. A schema alone does not keep test files apart: Kysely's introspection, which
 * its migrator asks whether its bookkeeping tables exist, reads every schema in the database and
 * fails on one that another file drops while it reads. No schema of another file's is in this
 * database. Dropped by `dropFileDatabase`, which the setup file runs after the file's tests.
 */
function fileDatabaseUrl(): Promise<string> {
  fileDatabase ??= (async () => {
    const name = `abele_test_${randomBytes(8).toString('hex')}`
    const admin = createDb(PG_TEST_URL)
    try {
      await sql.raw(`create database "${name}"`).execute(admin.db)
    } finally {
      await admin.close()
    }
    const url = new URL(PG_TEST_URL)
    url.pathname = `/${name}`
    return url.toString()
  })()
  return fileDatabase
}

/** Drops this file's database, if it made one; `with (force)` ends a pool a test left open. */
export async function dropFileDatabase(): Promise<void> {
  const pending = fileDatabase
  fileDatabase = undefined
  const url = await pending?.catch(() => undefined)
  if (url === undefined) return
  const admin = createDb(PG_TEST_URL)
  try {
    await sql
      .raw(`drop database if exists "${new URL(url).pathname.slice(1)}" with (force)`)
      .execute(admin.db)
  } finally {
    await admin.close()
  }
}

/**
 * One run's worth of Postgres: a schema of its own in the file's own database, migrated,
 * dropped on close, so two runs against the same server never meet and nothing is left behind.
 *
 * The schema goes on the connection's `search_path` through the startup
 * `options` parameter rather than by executing `set search_path`. Kysely runs on
 * a pool: a `set` reaches whichever connection happened to carry it and no
 * other, while a startup parameter is applied to every connection the pool opens.
 */
async function tempPgDb(migrate: Migrate): Promise<TempDb> {
  if (!hasPgTestDb) throw new Error('ABELE_TEST_PG_URL is not set')
  // Hex, so the name needs no quoting rules beyond the ones below and never collides.
  const schema = `t_${randomBytes(8).toString('hex')}`
  const url = withSearchPath(await fileDatabaseUrl(), schema)
  const handle = createDb(url)
  try {
    await sql.raw(`create schema "${schema}"`).execute(handle.db)
    // If the startup parameter never arrived, every table would go to `public`
    // and the tests would still pass while writing all over a shared database.
    const probe = sql<{ schema: string | null }>`select current_schema() as schema`
    const actual = (await probe.execute(handle.db)).rows[0]?.schema
    if (actual !== schema) {
      throw new Error(
        `ABELE_TEST_PG_URL did not take the search_path: current_schema() is ${actual ?? 'null'}`
      )
    }
    await migrate(handle.db, schema)
  } catch (error) {
    // Nothing may be left holding a pool open when the caller never got a handle.
    await handle.close().catch(() => undefined)
    throw error
  }

  return {
    ...handle,
    schema,
    url,
    async close() {
      try {
        await sql.raw(`drop schema if exists "${schema}" cascade`).execute(handle.db)
      } finally {
        await handle.close()
      }
    },
  }
}

/** The same server, with one schema in front of everything a connection looks up. */
function withSearchPath(url: string, schema: string): string {
  const parsed = new URL(url)
  // Whatever the URL already asked for is kept; the search path only goes in front.
  const existing = parsed.searchParams.get('options')
  const rest = existing === null || existing === '' ? '' : ` ${existing}`
  parsed.searchParams.set('options', `-c search_path=${schema}${rest}`)
  return parsed.toString()
}
