import { describe, expect, it } from 'vitest'
import { reproveFileSecurity } from '../../src/scoped/securityRepair.js'
import { buildTestApp, TEST_TOKEN_PEPPER } from '../helpers/testApp.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `merge repair incompleteness (${dialect})`,
    () => {
      for (const scenario of ['missing_merge', 'missing_base', 'persisted_partial_ids'] as const) {
        it(`keeps ${scenario} held across repeated repairs without upgrading writer or scope`, async () => {
          const t = await buildTestApp({ dialect })
          try {
            const owner = await t.account(),
              vault = (await t.vault(owner.accountToken)).vaultId,
              device = await t.device(owner.accountToken, vault)
            await putBlob(t.app, device.deviceToken, 'base')
            const base = (
              await commit(t.app, device.deviceToken, vault, [create('Agents/note.md', 'base')])
            ).results[0]
            await putBlob(t.app, device.deviceToken, 'head')
            const head = (
              await commit(t.app, device.deviceToken, vault, [
                {
                  op: 'modify',
                  file_id: base.file_id,
                  base_version_id: base.version_id,
                  sha: shaOf('head'),
                  size: 4,
                  mtime: 2,
                },
              ])
            ).results[0]
            const merge =
              scenario === 'missing_base'
                ? JSON.stringify({
                    head_version_id: base.version_id,
                    incoming_sha: shaOf('head'),
                    clean: true,
                  })
                : null
            await t.db
              .updateTable('versions')
              .set({ op: 'merge', merge })
              .where('id', '=', head.version_id)
              .execute()
            await t.db
              .deleteFrom('version_security_sources')
              .where('version_id', '=', head.version_id)
              .execute()
            if (scenario === 'persisted_partial_ids') {
              await t.db
                .insertInto('version_security_sources')
                .values({
                  version_id: head.version_id,
                  vault_id: vault,
                  file_id: head.file_id,
                  writer_facet: 'unknown',
                  writer_principal_id: null,
                  writer_account_id: null,
                  writer_grant_id: null,
                  executable: null,
                  settings: null,
                  source_version_ids: JSON.stringify([base.version_id]),
                  source_namespaces: null,
                  recorded_at: new Date().toISOString(),
                })
                .execute()
            }
            const deps = {
              db: t.db,
              dialect,
              pepper: TEST_TOKEN_PEPPER,
              accountTokenTtlMs: 3600000,
            }
            for (let attempt = 0; attempt < 3; attempt++) {
              const repaired = await reproveFileSecurity(
                deps,
                owner.accountToken,
                vault,
                head.file_id
              )
              expect(repaired.state, `repair ${attempt + 1}`).toBe('hold')
              const row = await t.db
                .selectFrom('version_security_sources')
                .selectAll()
                .where('version_id', '=', head.version_id)
                .executeTakeFirstOrThrow()
              expect(row).toMatchObject({
                writer_facet: 'unknown',
                writer_principal_id: null,
                executable: null,
                settings: null,
                source_namespaces: null,
              })
            }
          } finally {
            await t.close()
          }
        })
      }
    }
  )
}
