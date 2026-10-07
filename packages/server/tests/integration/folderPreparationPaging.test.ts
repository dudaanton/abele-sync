import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { login } from '../../src/auth/accounts.js'
import { TEST_PASSWORD } from '../helpers/testApp.js'
import { updateFolderGrant } from '../../src/auth/folderManagement.js'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

describe.skipIf(!hasPgTestDb)('bounded PostgreSQL folder preparation with 1,001 candidates', () => {
  let f: Awaited<ReturnType<typeof scopedFixture>>

  // Keep migration/authentication and DROP SCHEMA out of the test body's budget.
  // Like retentionClass, give these fixture hooks load headroom on the disposable
  // server's single CPU; the three set-based inserts are not per-file setup.
  beforeEach(async () => {
    f = await scopedFixture('pg')
    await sql`insert into files (id,vault_id,path,path_ci,kind,head_version_id,deleted_at)
      select 'bulk-'||n,${f.vault},'Agents/bulk-'||n||'.md','agents/bulk-'||n||'.md','note','bulk-version-'||n,null
      from generate_series(1,1001) as n`.execute(f.t.db)
    await sql`insert into versions (id,file_id,vault_id,seq,no,op,path,prev_path,blob_sha,size,mtime,actor_kind,actor_id,actor_name,created_at,prev_version_id,merge,retention_class)
      select 'bulk-version-'||n,'bulk-'||n,${f.vault},n,1,'create','Agents/bulk-'||n||'.md',null,null,0,0,'device',${f.device.deviceId},'Fixture','2030-01-01T00:00:00.000Z',null,null,'notes'
      from generate_series(1,1001) as n`.execute(f.t.db)
    await sql`insert into version_security_sources (version_id,vault_id,file_id,writer_facet,writer_principal_id,writer_account_id,executable,settings,source_version_ids,source_namespaces,recorded_at)
      select 'bulk-version-'||n,${f.vault},'bulk-'||n,'device',${f.device.deviceId},${f.owner.accountId},0,0,'[]','["agents"]','2030-01-01T00:00:00.000Z'
      from generate_series(1,1001) as n`.execute(f.t.db)
    await f.t.db
      .updateTable('vault_seq')
      .set({ head_seq: 1001 })
      .where('vault_id', '=', f.vault)
      .execute()
  }, 30_000)
  afterEach(async () => {
    await f?.close()
  }, 30_000)

  const prepare = async () => {
    let state = 'preparing'
    for (let i = 0; i < 4 && state !== 'active'; i++)
      state = (await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id))
        .state
    expect(state).toBe('active')
  }
  const members = () => f.t.db.selectFrom('scope_current_members').select('file_id').execute()

  it('prepares more than 1,000 synthetic folder candidates in bounded PostgreSQL pages', async () => {
    await prepare()
    expect(await members()).toHaveLength(1001)
  })

  // Each mutation starts from its own admitted 1,001-file baseline. Preparation
  // performs serial per-file SQL; chaining all five inventories in one test made
  // their cumulative latency exceed 30 seconds under load. Keep the same paging
  // coverage and assertions, but only two inventories per mutation test.
  it.each([
    ['rebuild', { rebuild: true }],
    ['expiry renewal', { expires_at: '2030-01-02T00:00:00.000Z' }],
    ['role change', { role: 'reader' }],
    ['prefix change', { prefix: 'Public/' }],
  ] as const)('clears and prepares all 1,001 candidates after %s', async (_name, change) => {
    await prepare()
    expect(await members()).toHaveLength(1001)
    if ('expires_at' in change)
      await f.t.db
        .updateTable('scope_grants')
        .set({ expires_at: '2029-12-31T00:00:00.000Z' })
        .where('id', '=', f.grant.id)
        .execute()
    await updateFolderGrant(f.deps, f.owner.accountToken, f.vault, f.grant.id, {
      expected_revision: 0,
      ...change,
    })
    expect(await members()).toHaveLength(0)
    await prepare()
    expect(await members()).toHaveLength('prefix' in change ? 0 : 1001)
  })
})

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `durable folder preparation (${dialect})`,
    () => {
      it('captures bounded pages, recovers after a restart and replays a private gap before activating', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'same')
          const rows = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/one.md', 'same'),
              create('Agents/two.md', 'same'),
              create('Agents/three.md', 'same'),
            ])
          ).results
          const first = await prepareFolderAdmissions(
            { ...f.deps, folderPreparationPageSize: 2 },
            f.owner.accountToken,
            f.vault,
            f.grant.id
          )
          expect(first).toMatchObject({ state: 'preparing', processed: 2 })
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              rows[0].file_id,
              rows[0].version_id
            )
          ).rejects.toMatchObject({ code: 'scope_updating' })
          const away = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: rows[0].file_id,
                base_version_id: rows[0].version_id,
                to_path: 'Private/gap.md',
              },
            ])
          ).results[0]
          await putBlob(f.t.app, f.device.deviceToken, 'private')
          const privateEdit = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'modify',
                file_id: rows[0].file_id,
                base_version_id: away.version_id,
                sha: shaOf('private'),
                size: 7,
                mtime: 2,
              },
            ])
          ).results[0]
          const returnHead = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: rows[0].file_id,
                base_version_id: privateEdit.version_id,
                to_path: 'Agents/one.md',
              },
            ])
          ).results[0]
          let result = first
          for (let i = 0; i < 8 && result.state !== 'active'; i++)
            result = await prepareFolderAdmissions(
              { ...f.deps, folderPreparationPageSize: 2 },
              f.owner.accountToken,
              f.vault,
              f.grant.id
            )
          expect(result.state).toBe('active')
          const admitted = await requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            rows[0].file_id,
            returnHead.version_id
          )
          expect(admitted.generation).toBeGreaterThanOrEqual(2)
          for (const version of [rows[0].version_id, away.version_id, privateEdit.version_id])
            await expect(
              requireFolderVersion(
                f.deps,
                f.a.key_token,
                f.vault,
                f.grant.id,
                rows[0].file_id,
                version
              )
            ).rejects.toMatchObject({ code: 'not_found' })
          for (const row of rows.slice(1))
            await expect(
              requireFolderVersion(
                f.deps,
                f.a.key_token,
                f.vault,
                f.grant.id,
                row.file_id,
                row.version_id
              )
            ).resolves.toBeDefined()
          expect(
            (await f.t.db.selectFrom('scope_folder_preparations').selectAll().execute())[0]
          ).toMatchObject({ phase: 'complete' })
        } finally {
          await f.close()
        }
      })
      it('holds when intermediate commit evidence was pruned instead of bridging a private gap', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'same')
          const heads = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/a.md', 'same'),
              create('Agents/b.md', 'same'),
            ])
          ).results
          await prepareFolderAdmissions(
            { ...f.deps, folderPreparationPageSize: 1 },
            f.owner.accountToken,
            f.vault,
            f.grant.id
          )
          const moved = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: heads[0].file_id,
                base_version_id: heads[0].version_id,
                to_path: 'Private/a.md',
              },
            ])
          ).results[0]
          const again = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: heads[0].file_id,
                base_version_id: moved.version_id,
                to_path: 'Agents/a.md',
              },
            ])
          ).results[0]
          await f.t.db.deleteFrom('versions').where('id', '=', moved.version_id).execute()
          await expect(
            prepareFolderAdmissions(
              { ...f.deps, folderPreparationPageSize: 1 },
              f.owner.accountToken,
              f.vault,
              f.grant.id
            )
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              again.file_id,
              again.version_id
            )
          ).rejects.toMatchObject({ code: 'scope_updating' })
        } finally {
          await f.close()
        }
      })
      it('does not certify an expired preparation lease or silently restart a partial inventory', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'note')
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/note.md', 'note'),
            create('Agents/other.md', 'note'),
          ])
          const first = await prepareFolderAdmissions(
            { ...f.deps, folderPreparationPageSize: 1 },
            f.owner.accountToken,
            f.vault,
            f.grant.id
          )
          expect(first.state).toBe('preparing')
          f.setClock('2030-01-01T00:05:00.000Z')
          const session = (
            await login(
              f.deps,
              (
                await f.t.db
                  .selectFrom('accounts')
                  .select('email')
                  .where('id', '=', f.owner.accountId)
                  .executeTakeFirstOrThrow()
              ).email,
              TEST_PASSWORD
            )
          ).account_token
          await expect(
            prepareFolderAdmissions(f.deps, session, f.vault, f.grant.id)
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
          await updateFolderGrant(f.deps, session, f.vault, f.grant.id, {
            expected_revision: 0,
            rebuild: true,
          })
          let result = await prepareFolderAdmissions(f.deps, session, f.vault, f.grant.id)
          for (let i = 0; i < 4 && result.state !== 'active'; i++)
            result = await prepareFolderAdmissions(f.deps, session, f.vault, f.grant.id)
          expect(result.state).toBe('active')
        } finally {
          await f.close()
        }
      })
    }
  )
}
