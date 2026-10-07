import { describe, expect, it } from 'vitest'
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'
import { down, up, WIDE_COLUMNS } from '../../src/db/migrations/003_wide_numbers.js'

/** A Kysely that runs nothing and remembers every statement it was handed. */
function recording(dialect: 'pg' | 'sqlite'): { db: Kysely<unknown>; statements: string[] } {
  const statements: string[] = []
  const pg = dialect === 'pg'
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => (pg ? new PostgresAdapter() : new SqliteAdapter()),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => (pg ? new PostgresIntrospector(k) : new SqliteIntrospector(k)),
      createQueryCompiler: () => (pg ? new PostgresQueryCompiler() : new SqliteQueryCompiler()),
    },
    log: (event) => {
      if (event.level === 'query') statements.push(event.query.sql)
    },
  })
  return { db, statements }
}

describe('003_wide_numbers', () => {
  it('rewrites each table once on Postgres: one statement carries all its columns', async () => {
    const { db, statements } = recording('pg')
    await up(db)
    expect(statements).toHaveLength(WIDE_COLUMNS.length)
    const versions = statements.find((s) => s.startsWith('alter table "versions"'))
    expect(versions).toBe(
      'alter table "versions" alter column "seq" type bigint, ' +
        'alter column "size" type bigint, alter column "mtime" type bigint'
    )
    statements.length = 0
    await down(db)
    expect(statements).toHaveLength(WIDE_COLUMNS.length)
  })

  it('writes nothing on SQLite, whose integers are already eight bytes', async () => {
    const { db, statements } = recording('sqlite')
    await up(db)
    await down(db)
    expect(statements).toEqual([])
  })
})
