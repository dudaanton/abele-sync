import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { tempDb, hasPgTestDb } from '../helpers/tempDb.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createUser, authenticateToken, issueToken } from '../../src/access/tokens.js'
import { decodeAccessToken } from '@abele/sync-protocol'
import { createHmac } from 'node:crypto'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`item migration (${dialect})`, () => {
    it('upgrades populated scopes and tokens without rewriting identities or foreign keys', async () => {
      const t = await tempDb(dialect, (db, schema) => runMigrations(db, schema, '009_generation'))
      try {
        const deps = { db: t.db, pepper: 'test', dialect }
        const root = await createUser(deps, 'Owner', 'https://sync.example')
        const key = decodeAccessToken(root.token).key
        const original = await t.db
          .selectFrom('access_scopes')
          .selectAll()
          .executeTakeFirstOrThrow()
        await t.db
          .insertInto('access_scopes')
          .values({
            ...original,
            id: 'child-scope',
            boundary_scope_id: original.id,
            effective_key: 'child',
          })
          .execute()
        const parent = await t.db.selectFrom('access_tokens').selectAll().executeTakeFirstOrThrow()
        const childKey = 'b'.repeat(43)
        await t.db
          .insertInto('access_tokens')
          .values({
            ...parent,
            id: 'child-token',
            scope_id: 'child-scope',
            issued_by_token_id: parent.id,
            secret_hash: createHmac('sha256', deps.pepper).update(childKey).digest('hex'),
          })
          .execute()
        await t.db
          .insertInto('scope_members')
          .values({ scope_id: original.id, file_id: 'old-member', item: '{}' })
          .execute()
        await t.db
          .insertInto('scope_changes')
          .values({ scope_id: original.id, cursor: 7, type: 'content', event: '{}' })
          .execute()
        const tokens = await t.db.selectFrom('access_tokens').selectAll().execute()
        const scopes = await t.db.selectFrom('access_scopes').selectAll().execute()
        await runMigrations(t.db, t.schema)
        await runMigrations(t.db, t.schema)
        expect(await t.db.selectFrom('access_tokens').selectAll().execute()).toEqual(tokens)
        expect(await t.db.selectFrom('access_scopes').selectAll().execute()).toEqual(scopes)
        expect((await authenticateToken(deps, key)).token.id).toBe(root.info.id)
        expect((await authenticateToken(deps, childKey)).scope.id).toBe('child-scope')
        expect(await t.db.selectFrom('scope_members').selectAll().execute()).toEqual([
          { scope_id: original.id, file_id: 'old-member', item: '{}' },
        ])
        expect(await t.db.selectFrom('scope_changes').selectAll().execute()).toEqual([
          { scope_id: original.id, cursor: 7, type: 'content', event: '{}' },
        ])
        expect(
          (
            await issueToken(deps, key, {
              scope: { kind: 'folder', id: root.info.scope.id },
              label: 'Child',
            })
          ).info.scope.id
        ).toBe(root.info.scope.id)
        await t.db
          .insertInto('access_scopes')
          .values({
            ...scopes[0]!,
            id: 'file-scope',
            kind: 'file',
            target_id: 'file',
            effective_key: 'file:file',
          })
          .execute()
        if (dialect === 'sqlite')
          expect((await sql`pragma foreign_key_check`.execute(t.db)).rows).toEqual([])
      } finally {
        await t.close()
      }
    })
  })
