import { sql } from 'kysely'
import type { Dialect } from '../../src/db/connect.js'
import { Migrator } from 'kysely/migration'
import { describe, expect, it } from 'vitest'
import * as init from '../../src/db/migrations/001_init.js'
import * as versionsVaultSha from '../../src/db/migrations/002_versions_vault_sha.js'
import * as wideNumbers from '../../src/db/migrations/003_wide_numbers.js'
import * as devicesEnrolledBy from '../../src/db/migrations/004_devices_enrolled_by.js'
import * as blobUploads from '../../src/db/migrations/005_blob_uploads.js'
import * as uploadOwners from '../../src/db/migrations/006_upload_owners.js'
import { runMigrations as migrate } from '../../src/db/migrate.js'
// This regression owns the 006↔007 boundary, independently of later scoped releases.
const runMigrations: typeof migrate = (db, schema) =>
  migrate(db, schema, '007_version_retention_class')
import { up, down } from '../../src/db/migrations/007_version_retention_class.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'

/** The deployed schema, independent of whichever migration production adds next. */
const legacy = {
  '001_init': init,
  '002_versions_vault_sha': versionsVaultSha,
  '003_wide_numbers': wideNumbers,
  '004_devices_enrolled_by': devicesEnrolledBy,
  '005_blob_uploads': blobUploads,
  '006_upload_owners': uploadOwners,
}

const legacyDb = (dialect: Dialect) =>
  tempDb(dialect, async (db, schema) => {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: async () => legacy },
      ...(schema === undefined ? {} : { migrationTableSchema: schema }),
    })
    const result = await migrator.migrateToLatest()
    if (result.error) throw result.error
  })

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `version retention migration (${dialect})`,
    () => {
      it('backfills populated 006 history from each version path, not the current file kind or scripts folder', async () => {
        const handle = await legacyDb(dialect)
        const { db, schema } = handle
        try {
          await db
            .insertInto('vaults')
            .values({
              id: 'vault',
              owner_account_id: 'account',
              name: 'Sample',
              settings: JSON.stringify({ scripts_folder: 'Automation' }),
              created_at: '2026-01-01T00:00:00.000Z',
            })
            .execute()
          await db
            .insertInto('files')
            .values({
              id: 'file',
              vault_id: 'vault',
              path: 'Renamed.bin',
              path_ci: 'renamed.bin',
              kind: 'attachment',
              head_version_id: 'version-7',
              deleted_at: null,
            })
            .execute()
          const cases = [
            ['Archive.MD', 'notes', 'create'],
            ['Sketch.CANVAS', 'notes', 'move'],
            ['.obsidian/app.md', 'settings', 'restore'],
            ['.obsidian/plugins/sample/main.js', 'settings', 'conflict'],
            ['Scripts/sample.js', 'attachments', 'modify'],
            ['Automation/sample.JS', 'attachments', 'merge'],
            ['Résumé.md', 'notes', 'delete'],
            ['Renamed.bin', 'attachments', 'restore'],
          ] as const
          for (const [i, [path, , op]] of cases.entries()) {
            await sql`insert into versions (id, file_id, vault_id, seq, no, op, path, prev_path,
            blob_sha, size, mtime, actor_kind, actor_id, actor_name, created_at, prev_version_id, merge)
            values (${`version-${i}`}, 'file', 'vault', ${i + 1}, ${i + 1}, ${op}, ${path}, null,
              null, 0, 0, 'device', 'device', 'Sample device', '2026-01-01T00:00:00.000Z', null, null)`.execute(
              db
            )
          }
          const before = (
            await sql<Record<string, unknown>>`select * from versions order by seq`.execute(db)
          ).rows
          const filesBefore = await db.selectFrom('files').selectAll().execute()

          await runMigrations(db, schema)
          const migrated = (
            await sql<Record<string, unknown>>`select * from versions order by seq`.execute(db)
          ).rows
          expect(migrated.map((v) => v.retention_class)).toEqual(
            cases.map(([, category]) => category)
          )
          expect(migrated.map(({ retention_class: _, ...v }) => v)).toEqual(before)
          expect(await db.selectFrom('files').selectAll().execute()).toEqual(filesBefore)
          await runMigrations(db, schema)
          expect((await sql`select * from versions order by seq`.execute(db)).rows).toEqual(
            migrated
          )

          // A missing class is safe unknown provenance, not a guess from the live file's kind.
          await sql`update versions set retention_class = null where id = 'version-0'`.execute(db)
          await expect(
            sql`update versions set retention_class = 'invalid' where id = 'version-1'`.execute(db)
          ).rejects.toThrow()
          const rolledBack = await new Migrator({
            db,
            provider: {
              getMigrations: async () => ({
                ...legacy,
                '007_version_retention_class': { up, down },
              }),
            },
            ...(schema === undefined ? {} : { migrationTableSchema: schema }),
          }).migrateDown()
          if (rolledBack.error) throw rolledBack.error
          expect((await sql`select * from versions order by seq`.execute(db)).rows).toEqual(before)
          await runMigrations(db, schema)
          expect((await sql`select * from versions order by seq`.execute(db)).rows).toEqual(
            migrated
          )
          // A retry must not reinterpret a class a newer writer has already stamped.
          await sql`update versions set retention_class = 'settings' where id = 'version-0'`.execute(
            db
          )
          const stamped = (await sql`select * from versions order by seq`.execute(db)).rows
          // Simulate a stop after the schema transaction but before Kysely recorded success.
          await sql`delete from kysely_migration where name = '007_version_retention_class'`.execute(
            db
          )
          await runMigrations(db, schema)
          expect((await sql`select * from versions order by seq`.execute(db)).rows).toEqual(stamped)
        } finally {
          await handle.close()
        }
      })

      it('rolls back the added column when backfill fails and can retry the migration', async () => {
        const handle = await legacyDb(dialect)
        const { db, schema } = handle
        try {
          await sql`insert into versions (id, file_id, vault_id, seq, no, op, path,
            size, mtime, actor_kind, actor_id, actor_name, created_at)
            values ('version', 'file', 'vault', 1, 1, 'create', 'Archive.md',
              0, 0, 'device', 'device', 'Sample device', '2026-01-01T00:00:00.000Z')`.execute(db)
          if (dialect === 'sqlite') {
            await sql`create trigger fail_backfill before update on versions
              begin select raise(abort, 'backfill failed'); end`.execute(db)
          } else {
            await sql`create function fail_backfill() returns trigger language plpgsql as
              $$ begin raise exception 'backfill failed'; end $$`.execute(db)
            await sql`create trigger fail_backfill before update on versions
              for each row execute function fail_backfill()`.execute(db)
          }
          await expect(runMigrations(db, schema)).rejects.toThrow(/007_version_retention_class/)
          const failed = (await sql`select * from versions`.execute(db)).rows
          expect(failed).toHaveLength(1)
          expect(failed[0]).not.toHaveProperty('retention_class')
          if (dialect === 'sqlite') await sql`drop trigger fail_backfill`.execute(db)
          else await sql`drop trigger fail_backfill on versions`.execute(db)
          await runMigrations(db, schema)
          expect((await sql`select retention_class from versions`.execute(db)).rows).toEqual([
            { retention_class: 'notes' },
          ])
        } finally {
          await handle.close()
        }
      })
    }
  )
}
