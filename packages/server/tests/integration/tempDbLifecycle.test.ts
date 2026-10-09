import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/db/connect.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'

/** Inspect through another pool: a destroyed test driver cannot check its own cleanup. */
async function schemaExists(url: string, schema: string): Promise<boolean> {
  const inspector = createDb(url)
  try {
    const result = await sql<{ present: boolean }>`select exists (
      select 1 from pg_namespace where nspname = ${schema}
    ) as present`.execute(inspector.db)
    return result.rows[0]!.present
  } finally {
    await inspector.close()
  }
}

describe.skipIf(!hasPgTestDb)('PostgreSQL fixture lifecycle', () => {
  it('allows repeated and concurrent close without querying a destroyed driver', async () => {
    const handle = await tempDb('pg')
    try {
      expect(await schemaExists(handle.url!, handle.schema!)).toBe(true)
      await handle.close()
      await expect(Promise.all([handle.close(), handle.close()])).resolves.toEqual([
        undefined,
        undefined,
      ])
      expect(await schemaExists(handle.url!, handle.schema!)).toBe(false)
    } finally {
      await handle.close()
    }
  })

  it('drops the schema even if the caller already destroyed the driver', async () => {
    const handle = await tempDb('pg')
    try {
      await handle.db.destroy()
      await expect(handle.close()).resolves.toBeUndefined()
      expect(await schemaExists(handle.url!, handle.schema!)).toBe(false)
    } finally {
      await handle.close()
    }
  })

  it('drops a failed migration schema and releases its pool before rejecting', async () => {
    let url: string | undefined
    let schema: string | undefined
    const failure = new Error('synthetic migration failure')
    await expect(
      tempDb('pg', async (db, own) => {
        schema = own
        // Obtain this file's database name without reaching into helper state.
        const result = await sql<{
          database: string
        }>`select current_database() as database`.execute(db)
        const parsed = new URL(process.env.ABELE_TEST_PG_URL!)
        parsed.pathname = `/${result.rows[0]!.database}`
        url = parsed.toString()
        await sql`create table partial_migration (id text)`.execute(db)
        throw failure
      })
    ).rejects.toBe(failure)
    expect(schema).toBeDefined()
    expect(await schemaExists(url!, schema!)).toBe(false)
    const inspector = createDb(url!)
    try {
      const result = await sql<{ connections: number }>`select count(*)::int as connections
        from pg_stat_activity where datname = current_database()`.execute(inspector.db)
      expect(result.rows[0]!.connections).toBe(1)
    } finally {
      await inspector.close()
    }
  })
})
