import { describe, expect, it } from 'vitest'
import { commitScopedOperations } from '../../src/scoped/operations.js'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `scoped deletion/restoration (${dialect})`,
    () => {
      const setup = async () => {
        const f = await scopedFixture(dialect)
        await putBlob(f.t.app, f.device.deviceToken, 'base')
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'base')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        return { ...f, first }
      }
      it('keeps a concurrent edit over stale deletion and restores only an authorized retained version', async () => {
        const f = await setup()
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'new')
          const edited = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'modify',
                file_id: f.first.file_id,
                base_version_id: f.first.version_id,
                sha: shaOf('new'),
                size: 3,
                mtime: 2,
              },
            ])
          ).results[0]
          const stale = (
            await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
              { op: 'delete', file_id: f.first.file_id, base_version_id: f.first.version_id },
            ])
          ).results[0]!
          expect(stale).toMatchObject({ status: 'merged', sha: shaOf('new') })
          const removed = (
            await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
              { op: 'delete', file_id: f.first.file_id, base_version_id: edited.version_id },
            ])
          ).results[0]!
          expect(removed.status).toBe('applied')
          const restored = (
            await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
              { op: 'restore', file_id: f.first.file_id, version_id: f.first.version_id },
            ])
          ).results[0]!
          expect(restored).toMatchObject({
            status: 'applied',
            sha: shaOf('base'),
            path: 'Agents/note.md',
          })
          await requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            f.first.file_id,
            edited.version_id
          )
          await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
            { op: 'delete', file_id: f.first.file_id, base_version_id: restored.version_id },
          ])
          await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
            { op: 'restore', file_id: f.first.file_id, version_id: edited.version_id },
          ])
          await requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            f.first.file_id,
            f.first.version_id
          )
        } finally {
          await f.close()
        }
      })
      it('lets an admitted concurrent edit win over a real authorized deletion without private fallback', async () => {
        const f = await setup()
        try {
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            { op: 'delete', file_id: f.first.file_id, base_version_id: f.first.version_id },
          ])
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('recipient'),
            Buffer.from('recipient')
          )
          const result = (
            await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
              {
                op: 'modify',
                file_id: f.first.file_id,
                base_version_id: f.first.version_id,
                sha: shaOf('recipient'),
                size: 9,
                mtime: 3,
              },
            ])
          ).results[0]!
          expect(result).toMatchObject({
            status: 'applied',
            sha: shaOf('recipient'),
            path: 'Agents/note.md',
          })
        } finally {
          await f.close()
        }
      })
      it('acknowledges an authorized deletion with zero retention without reopening history', async () => {
        const f = await setup()
        try {
          const { api } = await import('../helpers/client.js'),
            { TEST_PASSWORD } = await import('../helpers/testApp.js')
          await api(f.t.app, f.device.deviceToken).patch(`/v1/vaults/${f.vault}/settings`, {
            retention: { notes_days: 0 },
            account_password: TEST_PASSWORD,
          })
          const result = await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
            { op: 'delete', file_id: f.first.file_id, base_version_id: f.first.version_id },
          ])
          expect(result.results[0]).toMatchObject({
            status: 'acknowledged',
            file_id: f.first.file_id,
          })
          expect(result.results[0]).not.toHaveProperty('path')
          expect(
            (
              await f.t.db
                .selectFrom('files')
                .select('deleted_at')
                .where('id', '=', f.first.file_id)
                .executeTakeFirstOrThrow()
            ).deleted_at
          ).not.toBeNull()
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              f.first.file_id,
              f.first.version_id
            )
          ).rejects.toMatchObject({ code: 'not_found' })
        } finally {
          await f.close()
        }
      })
      it('holds hidden restore versions and collision destinations without altering the original trash or occupying identity', async () => {
        const f = await setup()
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'private')
          const hidden = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Private/hidden.md', 'private'),
            ])
          ).results[0]
          await expect(
            commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
              { op: 'restore', file_id: f.first.file_id, version_id: hidden.version_id },
            ])
          ).rejects.toMatchObject({ code: 'not_found' })
          await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
            { op: 'delete', file_id: f.first.file_id, base_version_id: f.first.version_id },
          ])
          const occupying = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/note.md', 'private'),
            ])
          ).results[0]
          const before = await f.t.db.selectFrom('versions').select('id').execute()
          await expect(
            commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
              { op: 'restore', file_id: f.first.file_id, version_id: f.first.version_id },
            ])
          ).rejects.toMatchObject({ code: 'not_found' })
          expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual(before)
          expect(
            (
              await f.t.db
                .selectFrom('files')
                .select('head_version_id')
                .where('id', '=', occupying.file_id)
                .executeTakeFirstOrThrow()
            ).head_version_id
          ).toBe(occupying.version_id)
        } finally {
          await f.close()
        }
      })
    }
  )
