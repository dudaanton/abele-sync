import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/migrate.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped schema preflight (${dialect})`, () => {
    it('refuses a previous 009 shape without durable folder preparation rather than inventing journal evidence', async () => {
      const t = await tempDb(dialect)
      try {
        await t.db.schema.dropTable('scope_folder_preparations').execute()
        const before = (await sql`select * from kysely_migration order by name`.execute(t.db)).rows
        await expect(runMigrations(t.db, t.schema)).rejects.toThrow(/incompatible scoped schema/)
        expect(
          (await sql`select * from kysely_migration order by name`.execute(t.db)).rows
        ).toEqual(before)
      } finally {
        await t.close()
      }
    })
    it('refuses an earlier disposable 008 shape instead of pretending a matching journal is sufficient', async () => {
      const t = await tempDb(dialect)
      try {
        await t.db.schema
          .alterTable('version_security_sources')
          .dropColumn('source_namespaces')
          .execute()
        const before = (await sql`select * from kysely_migration order by name`.execute(t.db)).rows
        await expect(runMigrations(t.db, t.schema)).rejects.toThrow(/incompatible scoped schema/)
        expect(
          (await sql`select * from kysely_migration order by name`.execute(t.db)).rows
        ).toEqual(before)
      } finally {
        await t.close()
      }
    })
  })
}
