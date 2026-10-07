import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/migrate.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`upgrade preflight (${dialect})`, () => {
    for (const names of [
      ['007_index'],
      ['001_init', '003_wide_numbers'],
      ['001_init', '008_scoped_authority'],
    ]) {
      it(`refuses incompatible journal ${names.join(',')} before changing the schema`, async () => {
        const handle = await tempDb(dialect, async () => undefined)
        try {
          await sql`create table kysely_migration (name varchar(255) primary key, timestamp varchar(255) not null)`.execute(
            handle.db
          )
          for (const name of names) {
            await sql`insert into kysely_migration (name, timestamp) values (${name}, '2026-10-01T00:00:00.000Z')`.execute(
              handle.db
            )
          }
          await expect(runMigrations(handle.db, handle.schema)).rejects.toThrow(
            /migration ancestry/
          )
          const journal = (
            await sql<{ name: string }>`select name from kysely_migration order by name`.execute(
              handle.db
            )
          ).rows
          expect(journal.map((row) => row.name)).toEqual([...names].sort())
          // Preflight must not even create Kysely's lock table on a rejected database.
          await expect(
            sql`select * from kysely_migration_lock`.execute(handle.db)
          ).rejects.toThrow()
        } finally {
          await handle.close()
        }
      })
    }
    it('accepts a fresh install and records the hardening ancestry exactly', async () => {
      const handle = await tempDb(dialect, (db, schema) =>
        runMigrations(db, schema, '007_version_retention_class')
      )
      try {
        const journal = (
          await sql<{ name: string }>`select name from kysely_migration order by name`.execute(
            handle.db
          )
        ).rows
        expect(journal.map((row) => row.name)).toEqual([
          '001_init',
          '002_versions_vault_sha',
          '003_wide_numbers',
          '004_devices_enrolled_by',
          '005_blob_uploads',
          '006_upload_owners',
          '007_version_retention_class',
        ])
      } finally {
        await handle.close()
      }
    })
  })
}
