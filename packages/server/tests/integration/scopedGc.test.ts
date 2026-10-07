import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { runRetention } from '../../src/history/retention.js'
import { updateVaultSettings } from '../../src/vault/vaults.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp } from '../helpers/testApp.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped GC pins (${dialect})`, () => {
    for (const kind of ['snapshot', 'group', 'invalidated_snapshot'] as const) {
      it(`keeps a live ${kind} pin, then prunes bytes without deleting admissions or origin evidence after expiry`, async () => {
        let clock = new Date('2030-01-01T00:00:00.000Z')
        const t = await buildTestApp({ dialect, now: () => clock })
        try {
          const { accountId, accountToken } = await t.account()
          const { vaultId } = await t.vault(accountToken)
          const { deviceToken, deviceId } = await t.device(accountToken, vaultId)
          await putBlob(t.app, deviceToken, 'old content')
          const old = (
            await commit(t.app, deviceToken, vaultId, [create('Agents/sample.md', 'old content')])
          ).results[0]
          await putBlob(t.app, deviceToken, 'new content')
          await commit(t.app, deviceToken, vaultId, [
            {
              op: 'modify',
              file_id: old.file_id,
              base_version_id: old.version_id,
              sha: shaOf('new content'),
              size: 11,
              mtime: 1,
            },
          ])
          await updateVaultSettings({ ...t, dialect }, vaultId, { retention: { notes_days: 0 } })
          clock = new Date('2030-01-02T00:00:00.000Z')
          const at = clock.toISOString(),
            expires = '2030-01-02T00:05:00.000Z'
          await sql`insert into scope_grants (id,vault_id,owner_account_id,label,selector_kind,folder_prefix,role,created_at)
            values ('grant',${vaultId},${accountId},'Agents','folder','Agents/','editor',${at})`.execute(
            t.db
          )
          await sql`insert into scope_keys (id,grant_id,owner_account_id,name,token_hash,role,created_at,expires_at)
            values ('key','grant',${accountId},'Agent','synthetic','editor',${at},${expires})`.execute(
            t.db
          )
          await sql`insert into scope_admission_intervals (id,grant_id,vault_id,file_id,generation,intrinsic,baseline_version_id,admitted_at)
            values ('interval','grant',${vaultId},${old.file_id},1,1,${old.version_id},${at})`.execute(
            t.db
          )
          await sql`insert into scope_version_admissions (grant_id,vault_id,file_id,interval_id,generation,version_id,admitted_at)
            values ('grant',${vaultId},${old.file_id},'interval',1,${old.version_id},${at})`.execute(
            t.db
          )
          // Simulate legacy evidence loss despite fresh writes retaining security facts.
          await t.db
            .deleteFrom('version_security_sources')
            .where('version_id', '=', old.version_id)
            .execute()
          await sql`insert into version_security_sources (version_id,vault_id,file_id,writer_facet,executable,settings,source_version_ids,recorded_at)
            values (${old.version_id},${vaultId},${old.file_id},'unknown',null,null,'["missing-source"]',${at})`.execute(
            t.db
          )
          await sql`insert into scope_group_origins (id,vault_id,source_file_id,token_key,introduced_version_id,introduced_at,origin_kind,writer_facet)
            values ('origin',${vaultId},${old.file_id},'Books',${old.version_id},${at},'unknown','unknown')`.execute(
            t.db
          )
          if (kind !== 'group') {
            await sql`insert into scope_snapshots (id,grant_id,vault_id,principal_kind,principal_id,key_id,scope_revision,acl_revision,publication_revision,feed_generation,feed_position,row_count,created_at,expires_at)
              values ('snapshot','grant',${vaultId},'key','key','key',0,0,0,0,0,1,${at},${expires})`.execute(
              t.db
            )
            await sql`insert into scope_snapshot_items (snapshot_id,grant_id,vault_id,ordinal,file_id,interval_id,version_id,path,kind,sha,size,mtime)
              values ('snapshot','grant',${vaultId},0,${old.file_id},'interval',${old.version_id},'Agents/sample.md','note',${shaOf('old content')},11,1)`.execute(
              t.db
            )
            await sql`insert into scope_snapshot_pins values ('snapshot','grant',${vaultId},${old.file_id},${old.version_id},${shaOf('old content')})`.execute(
              t.db
            )
          } else {
            await sql`insert into scope_group_leases (id,vault_id,start_seq,created_at,expires_at) values ('lease',${vaultId},1,${at},${expires})`.execute(
              t.db
            )
            await sql`insert into scope_group_pins values ('lease',${vaultId},${old.file_id},${old.version_id})`.execute(
              t.db
            )
          }
          const config = loadConfig({
            ABELE_MASTER_KEY: 'ab'.repeat(32),
            ABELE_TOKEN_PEPPER: 'test',
            ABELE_BLOB_DIR: t.store.dir,
          })
          const uploads = createUploadManager({ ...t, config })
          const gc = () =>
            runRetention({ ...t, dialect, uploads, idempotencyTtlMs: 1, now: () => clock })
          expect((await gc()).versions_removed).toBe(0)
          expect(await t.store.has(shaOf('old content'))).toBe(true)
          if (kind === 'invalidated_snapshot') {
            await t.db
              .updateTable('scope_snapshots')
              .set({ state: 'invalidated' })
              .where('id', '=', 'snapshot')
              .execute()
            expect((await gc()).versions_removed).toBe(1)
          }
          // The expired pin's compact evidence cannot keep the payload forever.
          clock = new Date('2030-01-02T00:05:00.000Z')
          expect((await gc()).versions_removed).toBe(kind === 'invalidated_snapshot' ? 0 : 1)
          clock = new Date('2030-01-02T02:00:00.000Z')
          await gc()
          expect(await t.store.has(shaOf('old content'))).toBe(false)
          expect(
            (await sql`select version_id from scope_version_admissions`.execute(t.db)).rows
          ).toEqual([{ version_id: old.version_id }])
          expect(
            (await sql`select introduced_version_id from scope_group_origins`.execute(t.db)).rows
          ).toEqual([{ introduced_version_id: old.version_id }])
          expect(
            (
              await sql`select executable,settings from version_security_sources where version_id = ${old.version_id}`.execute(
                t.db
              )
            ).rows
          ).toEqual([{ executable: null, settings: null }])
          // Unknown legacy lineage is file-local; personal sync remains available.
          const healthy = await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/manifest`)
          expect(healthy.status).toBe(200)
          expect(healthy.body.items[0].sha).toBe(shaOf('new content'))
          expect(deviceId).toBeTruthy()
        } finally {
          await t.close()
        }
      })
    }
  })
}
