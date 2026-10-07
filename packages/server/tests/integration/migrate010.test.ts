import { describe, expect, it } from 'vitest'
import { caseKey } from '@abele/sync-protocol'
import { tempDb, hasPgTestDb } from '../helpers/tempDb.js'
import { runMigrations } from '../../src/db/migrate.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `historical Unicode key migration (${dialect})`,
    () => {
      it('refuses an already recorded 010 with a missing path-key index instead of silently repairing its journal/schema', async () => {
        const t = await tempDb(dialect)
        try {
          await t.db.schema.dropIndex('versions_vault_path_ci_seq').execute()
          await expect(runMigrations(t.db, t.schema)).rejects.toThrow(
            'incompatible historical path schema'
          )
        } finally {
          await t.close()
        }
      })
      it('backfills JS/NFC keys transactionally and never leaves a partial DDL/journal after failure', async () => {
        const t = await tempDb(dialect, (db, schema) =>
          runMigrations(db, schema, '009_scoped_views')
        )
        try {
          const paths = ['Проект/Корень.md', 'ΠΡΟΤΖΕΚΤ/ΟΣ.md', 'Équipe/İRİS.md']
          for (const [n, path] of paths.entries())
            await t.db
              .insertInto('versions')
              .values({
                id: `v${n}`,
                file_id: `f${n}`,
                vault_id: 'vault',
                seq: n + 1,
                no: 1,
                op: 'create',
                path,
                prev_path: null,
                blob_sha: null,
                size: 0,
                mtime: 1,
                actor_kind: 'device',
                actor_id: 'd',
                actor_name: 'd',
                created_at: '2030-01-01T00:00:00.000Z',
                prev_version_id: null,
                merge: null,
              })
              .execute()
          const fault = {
            transformQuery({ node }: any) {
              if (node.kind === 'UpdateQueryNode' && JSON.stringify(node).includes('path_ci'))
                throw new Error('folded path fault')
              return node
            },
            async transformResult({ result }: any) {
              return result
            },
          }
          await expect(runMigrations(t.db.withPlugin(fault), t.schema)).rejects.toThrow(
            'migration 010_version_path_keys failed'
          )
          const table = (await t.db.introspection.getTables()).find(
            (row) => row.name === 'versions'
          )!
          expect(table.columns.map((col) => col.name)).not.toContain('path_ci')
          await runMigrations(t.db, t.schema)
          const rows = await t.db
            .selectFrom('versions')
            .select(['path', 'path_ci'])
            .orderBy('seq')
            .execute()
          expect(rows).toEqual(paths.map((path) => ({ path, path_ci: caseKey(path) })))
          await runMigrations(t.db, t.schema)
          expect(
            await t.db.selectFrom('versions').select(['path', 'path_ci']).orderBy('seq').execute()
          ).toEqual(rows)
        } finally {
          await t.close()
        }
      })
    }
  )
