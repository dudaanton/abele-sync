import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/migrate.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { at, populated007, seedAuthority, views } from '../helpers/scopedMigration.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`bounded evidence leases (${dialect})`, () => {
    it('refuses snapshot and preparation pins that could retain payloads past five minutes', async () => {
      const t = await populated007(dialect)
      try {
        await runMigrations(t.db, t.schema, views)
        await seedAuthority(t.db)
        for (const expiry of ['2030-01-01T00:05:00.001Z', '2099-01-01T00:00:00.000Z']) {
          await expect(
            sql`insert into scope_group_leases (id,vault_id,start_seq,created_at,expires_at)
            values ('lease','vault',1,${at},${expiry})`.execute(t.db)
          ).rejects.toThrow()
          await expect(
            sql`insert into scope_snapshots (id,grant_id,vault_id,principal_kind,principal_id,key_id,scope_revision,acl_revision,publication_revision,feed_generation,feed_position,row_count,created_at,expires_at)
            values ('snapshot','grant','vault','key','key','key',0,0,0,0,0,0,${at},${expiry})`.execute(
              t.db
            )
          ).rejects.toThrow()
        }
      } finally {
        await t.close()
      }
    })
  })
}
