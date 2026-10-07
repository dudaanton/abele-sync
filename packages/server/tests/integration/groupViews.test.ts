import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { requireFolderVersion } from '../../src/scoped/admissions.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `certified group admissions (${dialect})`,
    () => {
      it('cascades a subgroup deletion without treating detached child history as trash', async () => {
        const f = await scopedFixture(dialect)
        try {
          await f.t.db
            .updateTable('scope_grants')
            .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
            .where('id', '=', f.grant.id)
            .execute()
          await putBlob(f.t.app, f.device.deviceToken, 'root')
          const root = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')])
          ).results[0]
          await f.t.db
            .updateTable('scope_grants')
            .set({ root_file_id: root.file_id })
            .where('id', '=', f.grant.id)
            .execute()
          const subgroup = '---\ngroups: ["[[Root]]"]\n---\nsub'
          await putBlob(f.t.app, f.device.deviceToken, subgroup)
          const sub = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Sub.md', subgroup)])
          ).results[0]
          await f.t.db
            .insertInto('scope_group_anchors')
            .values({
              grant_id: f.grant.id,
              vault_id: f.vault,
              file_id: sub.file_id,
              owner_account_id: f.owner.accountId,
              approved_device_id: f.device.deviceId,
              approved_at: f.deps.now().toISOString(),
              approval_version_id: sub.version_id,
            })
            .execute()
          const childbody = '---\ngroups: ["[[Sub]]"]\n---\nchild'
          await putBlob(f.t.app, f.device.deviceToken, childbody)
          const child = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Child.md', childbody)])
          ).results[0]
          await processGroupDirtyPage(f.deps, f.vault, 10)
          await requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            child.file_id,
            child.version_id
          )
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            { op: 'delete', file_id: sub.file_id, base_version_id: sub.version_id },
          ])
          await processGroupDirtyPage(f.deps, f.vault, 10)
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              child.file_id,
              child.version_id
            )
          ).rejects.toMatchObject({ code: 'not_found' })
          expect(
            await f.t.db
              .selectFrom('scope_trash')
              .select('file_id')
              .where('file_id', '=', child.file_id)
              .execute()
          ).toEqual([])
        } finally {
          await f.close()
        }
      })
      it('keeps an unknown file local to its hold instead of disabling certified unrelated notes', async () => {
        const f = await scopedFixture(dialect)
        try {
          await f.t.db
            .updateTable('scope_grants')
            .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
            .where('id', '=', f.grant.id)
            .execute()
          await putBlob(f.t.app, f.device.deviceToken, 'root')
          const root = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')])
          ).results[0]
          await f.t.db
            .updateTable('scope_grants')
            .set({ root_file_id: root.file_id })
            .where('id', '=', f.grant.id)
            .execute()
          const body = '---\ngroups: ["[[Root]]"]\n---\nshared'
          await putBlob(f.t.app, f.device.deviceToken, body)
          const heads = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Safe.md', body),
              create('Unknown.md', body),
            ])
          ).results
          await f.t.db
            .deleteFrom('version_security_sources')
            .where('version_id', '=', heads[1].version_id)
            .execute()
          expect((await processGroupDirtyPage(f.deps, f.vault, 10)).ready).toBe(true)
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              heads[0].file_id,
              heads[0].version_id
            )
          ).resolves.toBeDefined()
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              heads[1].file_id,
              heads[1].version_id
            )
          ).rejects.toMatchObject({ code: 'not_found' })
        } finally {
          await f.close()
        }
      })
      it('closes intermediate membership gaps and admits only a fresh re-entry baseline before serving common reads', async () => {
        const f = await scopedFixture(dialect)
        try {
          await f.t.db
            .updateTable('scope_grants')
            .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
            .where('id', '=', f.grant.id)
            .execute()
          await putBlob(f.t.app, f.device.deviceToken, 'root')
          const root = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')])
          ).results[0]
          await f.t.db
            .updateTable('scope_grants')
            .set({ root_file_id: root.file_id })
            .where('id', '=', f.grant.id)
            .execute()
          const body = '---\ngroups: ["[[Root]]"]\n---\nshared'
          await putBlob(f.t.app, f.device.deviceToken, body)
          const first = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Member.md', body)])
          ).results[0]
          await processGroupDirtyPage(f.deps, f.vault, 10)
          expect(
            (await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)).items.map(
              (item) => item.file_id
            )
          ).toContain(first.file_id)
          await putBlob(f.t.app, f.device.deviceToken, 'private gap')
          const gap = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'modify',
                file_id: first.file_id,
                base_version_id: first.version_id,
                sha: shaOf('private gap'),
                size: 11,
                mtime: 2,
              },
            ])
          ).results[0]
          const reentry = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'modify',
                file_id: first.file_id,
                base_version_id: gap.version_id,
                sha: shaOf(body),
                size: body.length,
                mtime: 3,
              },
            ])
          ).results[0]
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              first.file_id,
              first.version_id
            )
          ).rejects.toMatchObject({ code: 'scope_updating' })
          await processGroupDirtyPage(f.deps, f.vault, 10)
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              first.file_id,
              first.version_id
            )
          ).rejects.toMatchObject({ code: 'not_found' })
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              first.file_id,
              reentry.version_id
            )
          ).resolves.toBeDefined()
        } finally {
          await f.close()
        }
      })
    }
  )
