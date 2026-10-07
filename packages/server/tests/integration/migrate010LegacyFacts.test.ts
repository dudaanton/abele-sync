import { describe, expect, it } from 'vitest'
import { tempDb, hasPgTestDb } from '../helpers/tempDb.js'
import { runMigrations } from '../../src/db/migrate.js'
import { readMigrationJournal } from '../../src/db/upgradePreflight.js'
import { createAccount } from '../../src/auth/accounts.js'
import { createVault } from '../../src/vault/vaults.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `010 legacy group evidence refusal (${dialect})`,
    () => {
      for (const retained of ['facts', 'bindings', 'origins'] as const)
        it(`refuses pre-010 ${retained} without mutating cached wrong Unicode origins or advancing DDL/journal`, async () => {
          const t = await tempDb(dialect, (db, schema) =>
            runMigrations(db, schema, '009_scoped_views')
          )
          try {
            const owner = await createAccount(
                { db: t.db, pepper: 'test', accountTokenTtlMs: 3600000 },
                'legacy@example.test',
                'pw'
              ),
              vault = (await createVault({ db: t.db }, owner.id, 'legacy')).id
            const origin = {
              id: 'legacy-origin',
              vault_id: vault,
              source_file_id: 'recipient-note',
              token_key: 'проект/корень.md',
              introduced_version_id: 'agent-v1',
              introduced_at: '2030-01-01T00:00:00.000Z',
              origin_kind: 'recipient' as const,
              writer_facet: 'scoped' as const,
              writer_principal_id: 'agent-key',
              writer_account_id: null,
              origin_grant_id: 'agents',
              target_file_id: null,
            }
            const fact = {
              vault_id: vault,
              file_id: 'recipient-note',
              version_id: 'agent-v1',
              status: 'valid' as const,
              facts: JSON.stringify({
                memory: {
                  'проект/корень.md': {
                    origin: { kind: 'recipient', id: 'legacy-origin' },
                    targetId: null,
                    bindingState: 'unresolved',
                  },
                },
                active: ['проект/корень.md'],
                uncertain: false,
              }),
              committed_seq: 2,
              recorded_at: '2030-01-01T00:00:00.000Z',
            }
            if (retained === 'facts')
              await t.db.insertInto('scope_group_parse_facts').values(fact).execute()
            else {
              await t.db.insertInto('scope_group_origins').values(origin).execute()
              if (retained === 'bindings')
                await t.db
                  .insertInto('scope_group_bindings')
                  .values({
                    vault_id: vault,
                    source_file_id: 'recipient-note',
                    token_key: origin.token_key,
                    origin_id: origin.id,
                    target_file_id: null,
                    state: 'unresolved',
                    approved_rebind_id: null,
                  })
                  .execute()
            }
            const before = {
              journal: await readMigrationJournal(t.db, t.schema ?? null),
              facts: await t.db.selectFrom('scope_group_parse_facts').selectAll().execute(),
              origins: await t.db.selectFrom('scope_group_origins').selectAll().execute(),
              bindings: await t.db.selectFrom('scope_group_bindings').selectAll().execute(),
            }
            await expect(runMigrations(t.db, t.schema)).rejects.toThrow(
              'pre-010 group evidence requires reviewed recovery'
            )
            expect(await readMigrationJournal(t.db, t.schema ?? null)).toEqual(before.journal)
            expect(
              (await t.db.introspection.getTables())
                .find((row) => row.name === 'versions')!
                .columns.map((col) => col.name)
            ).not.toContain('path_ci')
            expect(await t.db.selectFrom('scope_group_parse_facts').selectAll().execute()).toEqual(
              before.facts
            )
            expect(await t.db.selectFrom('scope_group_origins').selectAll().execute()).toEqual(
              before.origins
            )
            expect(await t.db.selectFrom('scope_group_bindings').selectAll().execute()).toEqual(
              before.bindings
            )
          } finally {
            await t.close()
          }
        })
    }
  )
