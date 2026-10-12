import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createUser } from '../../src/access/tokens.js'
import { runMigrations } from '../../src/db/migrate.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`fresh token-only schema (${dialect})`, () => {
    it('creates retained engine storage and token tables, with no old access tables', async () => {
      const handle = await tempDb(dialect, runMigrations)
      try {
        const names = (await handle.db.introspection.getTables()).map((table) => table.name)
        for (const table of [
          'users',
          'spaces',
          'directories',
          'access_tokens',
          'access_scopes',
          'files',
          'versions',
          'blobs',
          'uploads',
          'blob_uploads',
          'idempotency',
          'audit',
          'usage_daily',
          'vault_seq',
        ])
          expect(names).toContain(table)
        for (const table of [
          'accounts',
          'account_tokens',
          'vaults',
          'vault_members',
          'devices',
          'scope_grants',
          'version_security_sources',
        ])
          expect(names).not.toContain(table)
        await runMigrations(handle.db, handle.schema)
      } finally {
        await handle.close()
      }
    })
    it('refuses an old access schema instead of converting data or accepting old credentials', async () => {
      const handle = await tempDb(dialect, async () => {})
      try {
        await sql`create table accounts (id text primary key)`.execute(handle.db)
        await sql`insert into accounts (id) values ('old-user')`.execute(handle.db)
        await expect(runMigrations(handle.db, handle.schema)).rejects.toThrow(/fresh|wipe/i)
        expect(
          (await sql<{ id: string }>`select id from accounts`.execute(handle.db)).rows
        ).toEqual([{ id: 'old-user' }])
      } finally {
        await handle.close()
      }
    })
    it('rolls back user, space, root and scope if token insertion fails', async () => {
      const handle = await tempDb(dialect, runMigrations)
      try {
        if (dialect === 'sqlite')
          await sql
            .raw(
              "create trigger reject_test_token before insert on access_tokens begin select raise(abort, 'synthetic token insertion failure'); end"
            )
            .execute(handle.db)
        else
          await sql`alter table access_tokens add constraint reject_test_token check (label <> 'Fault')`.execute(
            handle.db
          )
        await expect(
          createUser(
            { db: handle.db, pepper: 'synthetic', dialect },
            'Fault',
            'https://sync.example'
          )
        ).rejects.toThrow()
        for (const table of [
          'users',
          'spaces',
          'directories',
          'access_scopes',
          'access_tokens',
        ] as const)
          expect(await handle.db.selectFrom(table).selectAll().execute()).toEqual([])
      } finally {
        await handle.close()
      }
    })
  })
}
