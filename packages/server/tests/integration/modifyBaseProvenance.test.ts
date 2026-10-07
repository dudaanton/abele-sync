import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `applied modify provenance (${dialect})`,
    () => {
      it('keeps B0 and B1 when a high-mtime binary edit from B0 directly replaces newer head B1', async () => {
        const t = await buildTestApp({ dialect })
        try {
          const owner = await t.account(),
            vault = (await t.vault(owner.accountToken)).vaultId,
            device = await t.device(owner.accountToken, vault)
          await putBlob(t.app, device.deviceToken, 'B0')
          const b0 = (
            await commit(t.app, device.deviceToken, vault, [create('Agents/data.bin', 'B0', 1)])
          ).results[0]
          await putBlob(t.app, device.deviceToken, 'B1')
          const b1 = (
            await commit(t.app, device.deviceToken, vault, [
              {
                op: 'modify',
                file_id: b0.file_id,
                base_version_id: b0.version_id,
                sha: shaOf('B1'),
                size: 2,
                mtime: 20,
              },
            ])
          ).results[0]
          await putBlob(t.app, device.deviceToken, 'incoming')
          const applied = (
            await commit(t.app, device.deviceToken, vault, [
              {
                op: 'modify',
                file_id: b0.file_id,
                base_version_id: b0.version_id,
                sha: shaOf('incoming'),
                size: 8,
                mtime: 30,
              },
            ])
          ).results[0]
          expect(applied.status).toBe('applied')
          const facts = await t.db
            .selectFrom('version_security_sources')
            .selectAll()
            .where('version_id', '=', applied.version_id)
            .executeTakeFirstOrThrow()
          expect(JSON.parse(facts.source_version_ids)).toEqual(
            expect.arrayContaining([b0.version_id, b1.version_id])
          )
          expect(facts).toMatchObject({
            writer_facet: 'device',
            writer_principal_id: device.deviceId,
            executable: 0,
            settings: 0,
          })
          const version = await t.db
            .selectFrom('versions')
            .select(['prev_version_id', 'merge'])
            .where('id', '=', applied.version_id)
            .executeTakeFirstOrThrow()
          expect(version).toEqual({ prev_version_id: b1.version_id, merge: null })
        } finally {
          await t.close()
        }
      })
    }
  )
}
