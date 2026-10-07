import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { createGroupGrant, updateGroupGrant } from '../../src/auth/groupManagement.js'
import { issueFolderKey } from '../../src/auth/folderManagement.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { approveGroupRelation } from '../../src/auth/groupApprovals.js'
import { commitScoped } from '../../src/scoped/commits.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { listFolderTrash } from '../../src/scoped/history.js'
const body = (text = 'shared') => `---\ngroups: ["[[Root]]"]\n---\n${text}`
async function fixture(dialect: 'sqlite' | 'pg', two = false) {
  const f = await scopedFixture(dialect)
  await putBlob(f.t.app, f.device.deviceToken, 'root')
  const root = (await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')]))
    .results[0]
  const add = async (name: string) => {
    const grant = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
      label: name,
      root_file_id: root.file_id,
      expected_root_version: root.version_id,
      role: 'editor',
    })
    const key = await issueFolderKey(f.deps, f.owner.accountToken, f.vault, grant.id, {
      attempt_id: name,
      name,
      role: 'editor',
      expires_at: '2030-01-02T00:00:00.000Z',
    })
    return { grant, key }
  }
  const a = await add('A'),
    b = two ? await add('B') : undefined
  await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
  await processGroupDirtyPage(f.deps, f.vault)
  const modify = async (file: any, text: string) => {
    await putBlob(f.t.app, f.device.deviceToken, text)
    return (
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'modify',
          file_id: file.file_id,
          base_version_id: file.version_id,
          sha: shaOf(text),
          size: Buffer.byteLength(text),
          mtime: 2,
        },
      ])
    ).results[0]
  }
  return { ...f, folderKey: f.a, root, a, b, add, modify }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`group lifecycle recovery (${dialect})`, () => {
    it('renewal of A does not skip membership gaps belonging to still-live B', async () => {
      const f = await fixture(dialect, true)
      try {
        await putBlob(f.t.app, f.device.deviceToken, body())
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Member.md', body())])
        ).results[0]
        await processGroupDirtyPage(f.deps, f.vault)
        await f.t.db
          .updateTable('scope_grants')
          .set({ expires_at: '2029-01-01T00:00:00.000Z' })
          .where('id', '=', f.a.grant.id)
          .execute()
        const departed = await f.modify(first, 'outside'),
          privateEdit = await f.modify(departed, 'private'),
          returned = await f.modify(privateEdit, body('returned'))
        await updateGroupGrant(f.deps, f.owner.accountToken, f.vault, f.a.grant.id, {
          expected_revision: 0,
          expires_at: '2030-01-02T00:00:00.000Z',
        })
        await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
        await processGroupDirtyPage(f.deps, f.vault)
        await expect(
          requireFolderVersion(
            f.deps,
            f.b!.key.key_token,
            f.vault,
            f.b!.grant.id,
            first.file_id,
            first.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
        await requireFolderVersion(
          f.deps,
          f.b!.key.key_token,
          f.vault,
          f.b!.grant.id,
          returned.file_id,
          returned.version_id
        )
      } finally {
        await f.close()
      }
    })
    it('a new audience starts at creation-time current content, not queued earlier versions', async () => {
      const f = await fixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, body('secret before B'))
        const secret = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Member.md', body('secret before B')),
          ])
        ).results[0]
        await processGroupDirtyPage(f.deps, f.vault)
        await putBlob(f.t.app, f.device.deviceToken, 'unrelated')
        await commit(f.t.app, f.device.deviceToken, f.vault, [create('Unrelated.md', 'unrelated')])
        const clean = await f.modify(secret, body('clean'))
        const b = await f.add('B')
        await processGroupDirtyPage(f.deps, f.vault)
        await expect(
          requireFolderVersion(
            f.deps,
            b.key.key_token,
            f.vault,
            b.grant.id,
            secret.file_id,
            secret.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
        await requireFolderVersion(
          f.deps,
          b.key.key_token,
          f.vault,
          b.grant.id,
          clean.file_id,
          clean.version_id
        )
      } finally {
        await f.close()
      }
    })
    for (const deletion of [false, true])
      it(`approval is audience-specific and ${deletion ? 'preserves authorized deletion trash' : 'does not widen B'}`, async () => {
        const f = await fixture(dialect, true)
        try {
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await uploadScopedBlob(
            f.deps,
            f.folderKey.key_token,
            f.vault,
            f.grant.id,
            shaOf(body()),
            Buffer.from(body())
          )
          const note = (
            await commitScoped(
              f.deps,
              f.folderKey.key_token,
              f.vault,
              f.grant.id,
              'recipient-note',
              [create('Agents/Note.md', body())]
            )
          ).results[0]!
          await processGroupDirtyPage(f.deps, f.vault)
          await approveGroupRelation(f.deps, f.owner.accountToken, f.vault, f.a.grant.id, {
            device_token: f.device.deviceToken,
            expected_revision: 0,
            source_file_id: note.file_id,
            source_version_id: note.version_id,
            target_file_id: f.root.file_id,
            target_version_id: f.root.version_id,
            token_key: 'root.md',
          })
          if (deletion) {
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              { op: 'delete', file_id: note.file_id, base_version_id: note.version_id },
            ])
            await processGroupDirtyPage(f.deps, f.vault)
            expect(
              (await listFolderTrash(f.deps, f.a.key.key_token, f.vault, f.a.grant.id)).items.map(
                (item) => item.file_id
              )
            ).toContain(note.file_id)
          } else {
            await requireFolderVersion(
              f.deps,
              f.a.key.key_token,
              f.vault,
              f.a.grant.id,
              note.file_id,
              note.version_id
            )
            await expect(
              requireFolderVersion(
                f.deps,
                f.b!.key.key_token,
                f.vault,
                f.b!.grant.id,
                note.file_id,
                note.version_id
              )
            ).rejects.toMatchObject({ code: 'not_found' })
          }
        } finally {
          await f.close()
        }
      })
    it('bootstrap proves the historical target identity despite a later ordinary root-body edit', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'root')
        const root = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, body())
        const note = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Member.md', body())])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'root edited')
        const edited = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: root.file_id,
              base_version_id: root.version_id,
              sha: shaOf('root edited'),
              size: 11,
              mtime: 2,
            },
          ])
        ).results[0]
        const grant = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
          label: 'Root',
          root_file_id: root.file_id,
          expected_root_version: edited.version_id,
          role: 'editor',
        })
        const key = await issueFolderKey(f.deps, f.owner.accountToken, f.vault, grant.id, {
          attempt_id: 'root',
          name: 'Root',
          role: 'editor',
          expires_at: '2030-01-02T00:00:00.000Z',
        })
        await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
        await processGroupDirtyPage(f.deps, f.vault)
        await expect(
          requireFolderVersion(
            f.deps,
            key.key_token,
            f.vault,
            grant.id,
            note.file_id,
            note.version_id
          )
        ).resolves.toBeDefined()
      } finally {
        await f.close()
      }
    })
  })
