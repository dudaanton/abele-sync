import { sql, type Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runMigrations, migrationChain } from '../../src/db/migrate.js'
import { up } from '../../src/db/migrations/011_conflict_divergences.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`conflict migration (${dialect})`, () => {
    it('upgrades fresh token schema, rolls back interrupted DDL, restarts, and never infers old lineage', async () => {
      const t = await tempDb(dialect, (db, schema) => runMigrations(db, schema, '003_sync_access'))
      try {
        await t.db
          .insertInto('users')
          .values({
            id: 'owner',
            label: 'Owner',
            created_at: '2030-01-01T00:00:00.000Z',
            disabled_at: null,
          })
          .execute()
        await t.db
          .insertInto('spaces')
          .values({
            id: 'v',
            user_id: 'owner',
            address: 'http://localhost',
            settings: '{}',
            created_at: '2030-01-01T00:00:00.000Z',
          })
          .execute()
        await t.db
          .insertInto('files')
          .values({
            id: 'old-copy',
            vault_id: 'v',
            path: 'N (Conflicted copy old 202601010000).md',
            path_ci: 'old',
            kind: 'note',
            head_version_id: null,
            deleted_at: null,
          })
          .execute()
        await expect(
          t.db.transaction().execute(async (tx) => {
            await up(tx as unknown as Kysely<unknown>)
            throw new Error('interrupted')
          })
        ).rejects.toThrow('interrupted')
        await expect(sql`select * from conflict_divergences`.execute(t.db)).rejects.toThrow()
        await runMigrations(t.db, t.schema)
        await runMigrations(t.db, t.schema)
        expect(await t.db.selectFrom('conflict_divergences').selectAll().execute()).toEqual([])
        expect(await t.db.selectFrom('files').select('id').execute()).toEqual([{ id: 'old-copy' }])
        expect(
          (
            await sql<{ name: string }>`select name from kysely_migration order by name`.execute(
              t.db
            )
          ).rows.map((r) => r.name)
        ).toEqual(migrationChain)
        await expect(runMigrations(t.db, t.schema, '003_sync_access')).rejects.toThrow(
          '004_conflict_divergences'
        )
        const row = {
          divergence_key: 'v1:k',
          vault_id: 'v',
          original_file_id: 'original',
          base_identity: 'version:v1:expired',
          incoming_sha: 'a'.repeat(64),
          create_path_ci: null,
          conflict_file_id: 'old-copy',
          conflict_version_id: 'expired-copy-version',
          first_head_version_id: 'expired-head',
          chosen_path: 'old',
          created_at: '2030-01-01T00:00:00.000Z',
          disposition: 'copy' as const,
        }
        await t.db.insertInto('conflict_divergences').values(row).execute()
        await expect(
          t.db
            .insertInto('conflict_divergences')
            .values({ ...row, divergence_key: 'different' })
            .execute()
        ).rejects.toThrow()
        await t.db.deleteFrom('files').where('id', '=', 'old-copy').execute()
        expect(await t.db.selectFrom('conflict_divergences').selectAll().execute()).toHaveLength(1)
        await t.db.deleteFrom('spaces').where('id', '=', 'v').execute()
        expect(await t.db.selectFrom('conflict_divergences').selectAll().execute()).toEqual([])
      } finally {
        await t.close()
      }
    })
    it('refuses an 011 journal whose durable identity table is missing before any repair', async () => {
      const t = await tempDb(dialect, runMigrations)
      try {
        await t.db.schema.dropTable('conflict_divergences').execute()
        await expect(runMigrations(t.db, t.schema)).rejects.toThrow(/conflict.*schema/)
      } finally {
        await t.close()
      }
    })
  })
