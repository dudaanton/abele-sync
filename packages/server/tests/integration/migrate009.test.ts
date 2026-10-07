import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/migrate.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'
import {
  authority,
  at,
  populated007,
  personalRows,
  seedAuthority,
  views,
} from '../helpers/scopedMigration.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`009 scoped views (${dialect})`, () => {
    it('upgrades populated 008 and matches a clean install without parked schema', async () => {
      const t = await populated007(dialect)
      const fresh = await tempDb(dialect)
      try {
        await runMigrations(t.db, t.schema, authority)
        await seedAuthority(t.db)
        const before = await personalRows(t.db)
        const grants = (await sql`select * from scope_grants`.execute(t.db)).rows
        await runMigrations(t.db, t.schema, views)
        expect(await personalRows(t.db)).toEqual(before)
        expect((await sql`select * from scope_grants`.execute(t.db)).rows).toEqual(grants)
        const own = async (db: typeof t.db, schema?: string) =>
          schema
            ? (
                await sql<{
                  name: string
                }>`select table_name as name from information_schema.tables where table_schema = ${schema} order by table_name`.execute(
                  db
                )
              ).rows.map((r) => r.name)
            : (await db.introspection.getTables()).map((r) => r.name).sort()
        const names = await own(t.db, t.schema)
        expect(await own(fresh.db, fresh.schema)).toEqual(names)
        for (const name of [
          'scope_admission_intervals',
          'scope_version_admissions',
          'scope_current_members',
          'scope_trash',
          'scope_feed_state',
          'scope_feed',
          'scope_snapshots',
          'scope_snapshot_items',
          'scope_snapshot_pins',
          'scope_group_origins',
          'scope_group_bindings',
          'scope_group_anchors',
          'scope_group_parse_facts',
          'scope_group_dirty',
          'scope_group_progress',
          'scope_group_leases',
          'scope_group_pins',
          'scope_extra_entries',
          'scope_extra_sponsors',
          'scope_publication_outcomes',
          'scope_native_files',
        ])
          expect(names).toContain(name)
        for (const name of names)
          expect(name).not.toMatch(
            /observations|dispositions|transactions|dependencies|references|signature/
          )
        await runMigrations(t.db, t.schema, views)
        await expect(runMigrations(t.db, t.schema, authority)).rejects.toThrow(/downgrade/)
      } finally {
        await t.close()
        await fresh.close()
      }
    })
    it('binds sponsor generations to intrinsic admissions and keeps minimal evidence after version pruning', async () => {
      const t = await populated007(dialect)
      try {
        await runMigrations(t.db, t.schema, views)
        await seedAuthority(t.db)
        await sql`insert into scope_admission_intervals (id,grant_id,vault_id,file_id,generation,intrinsic,baseline_version_id,admitted_at)
          values ('interval','grant','vault','file',1,1,'version',${at})`.execute(t.db)
        await sql`insert into scope_version_admissions (grant_id,vault_id,file_id,interval_id,generation,version_id,admitted_at)
          values ('grant','vault','file','interval',1,'version',${at})`.execute(t.db)
        await sql`insert into scope_extra_entries (id,grant_id,vault_id,file_id,origin,first_version_id,generation,created_at)
          values ('extra','grant','vault','image','owner','image-v1',1,${at})`.execute(t.db)
        await expect(
          sql`insert into scope_extra_sponsors (entry_id,grant_id,vault_id,note_id,interval_id,admission_generation,intrinsic,added_at)
          values ('extra','grant','vault','file','interval',2,1,${at})`.execute(t.db)
        ).rejects.toThrow()
        await expect(
          sql`insert into scope_extra_sponsors (entry_id,grant_id,vault_id,note_id,interval_id,admission_generation,intrinsic,added_at)
          values ('extra','grant','vault','file','interval',1,0,${at})`.execute(t.db)
        ).rejects.toThrow()
        await sql`insert into scope_extra_sponsors (entry_id,grant_id,vault_id,note_id,interval_id,admission_generation,intrinsic,added_at)
          values ('extra','grant','vault','file','interval',1,1,${at})`.execute(t.db)
        await sql`delete from versions where id = 'version'`.execute(t.db)
        expect(
          (await sql`select version_id from scope_version_admissions`.execute(t.db)).rows
        ).toEqual([{ version_id: 'version' }])
        expect(
          (await sql`select admission_generation from scope_extra_sponsors`.execute(t.db)).rows
        ).toEqual([{ admission_generation: 1 }])
      } finally {
        await t.close()
      }
    })
  })
}
