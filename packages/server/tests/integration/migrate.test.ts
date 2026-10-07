import { describe, it, expect } from 'vitest'
import { sql } from 'kysely'
import { createDb, type Dialect } from '../../src/db/connect.js'
import { hasPgTestDb, tempDb, type TempDb } from '../helpers/tempDb.js'
import { runMigrations } from '../../src/db/migrate.js'

const TABLES = [
  'accounts',
  'account_tokens',
  'devices',
  'vaults',
  'vault_members',
  'vault_seq',
  'files',
  'versions',
  'blobs',
  'uploads',
  'idempotency',
  'audit',
  'usage_daily',
]

interface OwnTable {
  name: string
  columns: Array<{ name: string; isNullable: boolean }>
}

/**
 * The tables this run migrated, and nothing else. On Postgres that is its own schema, read from
 * `information_schema` by name: Kysely's introspection walks every schema in the database, so it
 * would count a table another run created as one of ours, and fails outright on a schema that
 * is dropped while it reads.
 */
async function ownTables(db: TempDb['db'], schema: string | undefined): Promise<OwnTable[]> {
  if (schema === undefined) return db.introspection.getTables()
  const rows = await sql<{ table: string; column: string; nullable: string }>`
    select table_name as table, column_name as column, is_nullable as nullable
    from information_schema.columns
    where table_schema = ${schema}
    order by table_name, ordinal_position`.execute(db)
  const tables = new Map<string, OwnTable>()
  for (const row of rows.rows) {
    const table = tables.get(row.table) ?? { name: row.table, columns: [] }
    table.columns.push({ name: row.column, isNullable: row.nullable === 'YES' })
    tables.set(row.table, table)
  }
  return [...tables.values()]
}

/** The assertions are written once and asked of both dialects; only the database differs. */
async function createsEveryTable(dialect: Dialect): Promise<void> {
  const { db, close, schema } = await tempDb(dialect)
  const names = (await ownTables(db, schema)).map((t) => t.name).sort()
  for (const t of TABLES) expect(names).toContain(t)
  await expect(runMigrations(db, schema)).resolves.toBeUndefined()
  await sql`select 1`.execute(db)
  await close()
}

/** 004: which device enrolled a device, null for every row that came before it. */
async function recordsWhoEnrolled(dialect: Dialect): Promise<void> {
  const { db, close, schema } = await tempDb(dialect)
  const devices = (await ownTables(db, schema)).find((t) => t.name === 'devices')
  const column = devices?.columns.find((c) => c.name === 'enrolled_by')
  expect(column?.isNullable).toBe(true)
  await close()
}

async function onePathPerVault(dialect: Dialect): Promise<void> {
  const { db, close } = await tempDb(dialect)
  await db
    .insertInto('vaults')
    .values({ id: 'v', owner_account_id: 'a', name: 'V', settings: '{}', created_at: 't' })
    .execute()
  await db
    .insertInto('files')
    .values({
      id: 'f1',
      vault_id: 'v',
      path: 'A.md',
      path_ci: 'a.md',
      kind: 'note',
      head_version_id: null,
      deleted_at: null,
    })
    .execute()
  await expect(
    db
      .insertInto('files')
      .values({
        id: 'f2',
        vault_id: 'v',
        path: 'a.MD',
        path_ci: 'a.md',
        kind: 'note',
        head_version_id: null,
        deleted_at: null,
      })
      .execute()
  ).rejects.toThrow()
  await db
    .insertInto('files')
    .values({
      id: 'f3',
      vault_id: 'v',
      path: 'a.md',
      path_ci: 'a.md',
      kind: 'note',
      head_version_id: null,
      deleted_at: 't',
    })
    .execute()
  await close()
}

describe('migrations', () => {
  it('creates every table and is idempotent', () => createsEveryTable('sqlite'))
  it('enforces one live path per vault, case-insensitively', () => onePathPerVault('sqlite'))
  it('records which device enrolled a device', () => recordsWhoEnrolled('sqlite'))
  it('indexes versions by vault and blob, which the blob routes ask on every read', async () => {
    const { db, close } = await tempDb('sqlite')
    const found = await sql<{
      name: string
    }>`select name from sqlite_master where type = 'index' and name = 'versions_vault_sha'`.execute(
      db
    )
    expect(found.rows).toEqual([{ name: 'versions_vault_sha' }])
    await close()
  })
  it('throws when a migration fails', async () => {
    const { db, close } = createDb('sqlite::memory:')
    await sql`create table accounts (x integer)`.execute(db)
    await expect(runMigrations(db)).rejects.toThrow(/001_init/)
    await close()
  })
})

/**
 * The same schema on the other dialect. Postgres is not installed with the
 * repository: set `ABELE_TEST_PG_URL` to a server you do not mind being written
 * to, as a role that may create databases, and these run in a schema of their
 * own, in a database of the file's own, both dropped afterwards.
 * Unset, they are reported as skipped rather than quietly not existing.
 */
describe.skipIf(!hasPgTestDb)('migrations on postgres', () => {
  it('creates every table and is idempotent', () => createsEveryTable('pg'))
  it('enforces one live path per vault, case-insensitively', () => onePathPerVault('pg'))
  it('records which device enrolled a device', () => recordsWhoEnrolled('pg'))
  it("keeps its own bookkeeping in its own schema when another schema has Kysely's", async () => {
    // An empty schema of this run's, and in the same database another app's, fully migrated.
    const { db, close, schema } = await tempDb('pg', async () => undefined)
    const other = `${schema}_other`
    try {
      await sql.raw(`create schema "${other}"`).execute(db)
      await sql
        .raw(
          `create table "${other}".kysely_migration (name varchar(255) primary key, timestamp varchar(255) not null);
           create table "${other}".kysely_migration_lock (id varchar(255) primary key, is_locked integer not null default 0);
           insert into "${other}".kysely_migration_lock values ('migration_lock', 0);`
        )
        .execute(db)

      // As production calls it: no schema named.
      await runMigrations(db)

      const tables = await sql<{ name: string }>`
        select table_name as name from information_schema.tables
        where table_schema = ${schema!} order by table_name`.execute(db)
      const names = tables.rows.map((row) => row.name)
      for (const t of [...TABLES, 'kysely_migration', 'kysely_migration_lock']) {
        expect(names).toContain(t)
      }
      await expect(runMigrations(db)).resolves.toBeUndefined()
    } finally {
      await sql.raw(`drop schema if exists "${other}" cascade`).execute(db)
      await close()
    }
  })
})
