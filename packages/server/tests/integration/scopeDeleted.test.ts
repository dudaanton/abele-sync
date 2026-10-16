import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tokenFixture } from '../helpers/tokenFixture.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'
import { runMigrations } from '../../src/db/migrate.js'
import { runAdmin } from '../../src/admin-cli/index.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(dialect, () => {
    it('migrates existing deletion reasons without reclassifying ordinary revocations', async () => {
      const t = await tempDb(dialect, (db, schema) => runMigrations(db, schema, '007_read_only'))
      try {
        const at = '2026-10-16T00:00:00.000Z'
        await t.db
          .insertInto('users')
          .values({ id: 'u', label: 'Owner', created_at: at, disabled_at: null })
          .execute()
        await t.db
          .insertInto('spaces')
          .values({
            id: 'v',
            user_id: 'u',
            name: 'Vault',
            address: 'https://sync.example',
            settings: '{}',
            created_at: at,
            deleted_at: null,
          })
          .execute()
        await t.db
          .insertInto('directories')
          .values({
            id: 'd',
            space_id: 'v',
            parent_id: null,
            path: '/',
            version_id: 'version',
            mtime: 0,
            deleted_at: null,
          })
          .execute()
        await t.db
          .insertInto('access_scopes')
          .values({
            id: 's',
            space_id: 'v',
            kind: 'folder',
            target_id: 'd',
            boundary_scope_id: null,
            effective_key: 'root',
          })
          .execute()
        for (const id of ['deleted', 'ordinary'])
          await t.db
            .insertInto('access_tokens')
            .values({
              id,
              space_id: 'v',
              secret_hash: id,
              scope_id: 's',
              issued_by_token_id: null,
              label: id,
              created_at: at,
              revoked_at: at,
            })
            .execute()
        await t.db
          .insertInto('audit')
          .values({
            id: 'audit',
            vault_id: 'v',
            actor_kind: 'key',
            actor_id: 'deleted',
            action: 'connection.delete',
            path: '/',
            result: 'applied',
            at,
            details: JSON.stringify({ revoked_tokens: ['deleted'] }),
          })
          .execute()
        await runMigrations(t.db, t.schema)
        await runMigrations(t.db, t.schema)
        const rows = await t.db.selectFrom('access_tokens').selectAll().execute()
        expect(rows.find((r) => r.id === 'deleted')!.scope_deleted_at).toBe(at)
        expect(rows.find((r) => r.id === 'ordinary')!.scope_deleted_at).toBeNull()
        expect(
          rows.every(
            (r) =>
              r.last_used_at === null && r.last_address === null && r.address_status === 'unknown'
          )
        ).toBe(true)
        expect(await t.db.selectFrom('activity_daily').selectAll().execute()).toEqual([])
      } finally {
        await t.close()
      }
    })
    it('distinguishes deleted scopes on every route while retaining exact deletion replay', async () => {
      const f = await tokenFixture(dialect)
      try {
        const ordinary = await f.root.share(f.share.info.scope.id)
        await f.root.json('/tokens/' + ordinary.info.id, 'DELETE')
        const key = randomUUID()
        const result = await f.guest.json(
          '/connection/delete',
          'POST',
          {},
          { 'idempotency-key': key }
        )
        for (const [path, method, body] of [
          ['/connection', 'GET', undefined],
          ['/manifest', 'GET', undefined],
          ['/not-a-route', 'GET', undefined],
          ['/commit', 'POST', { ops: [] }],
          ['/connection/delete', 'POST', {}],
          ['/tokens', 'POST', {}],
        ] as const) {
          const r = await f.guest.request(path, method, body)
          expect(r.status).toBe(401)
          expect((await r.json()).error.code).toBe('scope_deleted')
        }
        expect(
          await f.guest.json('/connection/delete', 'POST', {}, { 'idempotency-key': key })
        ).toEqual(result)
        const invalid = await f.guest.request(
          '/connection/delete',
          'POST',
          { path: 'anything' },
          { 'idempotency-key': key }
        )
        expect((await invalid.json()).error.code).toBe('scope_deleted')
        const head = await f.guest.request('/connection', 'HEAD')
        expect(head.headers.get('x-abele-error-code')).toBe('scope_deleted')
        const r = await new V2SyncClient(ordinary.token).request('/connection')
        expect((await r.json()).error.code).toBe('unauthorized')
        expect(
          await runAdmin(
            ['vaults', 'delete', 'Owner', '--now', '--confirm-purge', '--yes'],
            {
              ABELE_DATABASE_URL: f.t.databaseUrl,
              ABELE_BLOB_DIR: f.t.config.blobDir,
              ABELE_MASTER_KEY: 'ab'.repeat(32),
              ABELE_TOKEN_PEPPER: f.t.config.tokenPepper,
            },
            { log: () => {}, error: () => {} }
          )
        ).toBe(0)
        expect((await (await f.guest.request('/connection')).json()).error.code).toBe(
          'scope_deleted'
        )
        expect(
          (await (await new V2SyncClient(ordinary.token).request('/connection')).json()).error.code
        ).toBe('unauthorized')
      } finally {
        await f.close()
      }
    })
  })
