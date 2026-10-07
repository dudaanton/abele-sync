import { describe, expect, it, vi } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import { issueFolderKey } from '../../src/auth/folderManagement.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { commitScoped } from '../../src/scoped/commits.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
// Smaller positive bounds exercise production branches without generating host load.
vi.mock('../../src/scoped/resourceLimits.js', () => ({
  SCOPED_RESOURCE_LIMITS: {
    cleanupPage: 1000,
    feedEvents: 4,
    pendingGroupVersions: 2,
    groupPins: 100000,
    snapshotPins: 1,
    liveExtraEntries: 1,
  },
}))
async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  await putBlob(f.t.app, f.device.deviceToken, 'root')
  const root = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [create('Project/Root.md', 'root')])
  ).results[0]
  const project = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
    label: 'Project',
    root_file_id: root.file_id,
    expected_root_version: root.version_id,
    role: 'editor',
  })
  const key = await issueFolderKey(f.deps, f.owner.accountToken, f.vault, project.id, {
    attempt_id: 'project',
    name: 'Project',
    role: 'editor',
    expires_at: '2030-01-02T00:00:00.000Z',
  })
  await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
  await processGroupDirtyPage(f.deps, f.vault)
  return { ...f, root, project, key }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `scoped resource certificates (${dialect})`,
    () => {
      it('durably holds group authority at a backlog ceiling but continues personal saves without growing pending work', async () => {
        const f = await fixture(dialect)
        try {
          for (let i = 0; i < 4; i++) {
            await putBlob(f.t.app, f.device.deviceToken, `v${i}`)
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create(`Personal/${i}.md`, `v${i}`),
            ])
          }
          const progress = await f.t.db
            .selectFrom('scope_group_progress')
            .selectAll()
            .where('vault_id', '=', f.vault)
            .executeTakeFirstOrThrow()
          expect(progress.status).toBe('unavailable')
          expect(
            await f.t.db
              .selectFrom('scope_group_dirty')
              .select('committed_seq')
              .where('committed_seq', '>', progress.processed_seq)
              .execute()
          ).toHaveLength(2)
          expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(5)
          await expect(
            openFolderSnapshot(f.deps, f.key.key_token, f.vault, f.project.id)
          ).rejects.toMatchObject({ code: 'scope_updating' })
          await expect(processGroupDirtyPage(f.deps, f.vault)).rejects.toMatchObject({
            code: 'scope_unavailable',
          })
        } finally {
          await f.close()
        }
      })
      it('bounds aggregate live snapshot pins and releases the bound only after expiry', async () => {
        const f = await fixture(dialect)
        try {
          await openFolderSnapshot(f.deps, f.key.key_token, f.vault, f.project.id)
          await expect(
            openFolderSnapshot(f.deps, f.key.key_token, f.vault, f.project.id)
          ).rejects.toMatchObject({ code: 'too_large' })
          f.setClock('2030-01-01T00:06:00.000Z')
          expect(
            (await openFolderSnapshot(f.deps, f.key.key_token, f.vault, f.project.id)).items
          ).toHaveLength(1)
        } finally {
          await f.close()
        }
      })
      it('applies the common live-extra budget to native attachment creation with atomic rollback', async () => {
        const f = await fixture(dialect)
        try {
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            shaOf('a'),
            Buffer.from('a')
          )
          await commitScoped(f.deps, f.key.key_token, f.vault, f.project.id, 'a', [
            { ...create('Attachments/a.png', 'a'), sponsor_note_id: f.root.file_id },
          ])
          await processGroupDirtyPage(f.deps, f.vault)
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            shaOf('b'),
            Buffer.from('b')
          )
          const before = await f.t.db.selectFrom('versions').select('id').execute()
          await expect(
            commitScoped(f.deps, f.key.key_token, f.vault, f.project.id, 'b', [
              { ...create('Attachments/b.png', 'b'), sponsor_note_id: f.root.file_id },
            ])
          ).rejects.toMatchObject({ code: 'too_large' })
          expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual(before)
          expect(
            await f.t.db.selectFrom('scope_extra_entries').select('id').execute()
          ).toHaveLength(1)
        } finally {
          await f.close()
        }
      })
    }
  )
