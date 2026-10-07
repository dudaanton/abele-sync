import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import { issueFolderKey } from '../../src/auth/folderManagement.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { commitScoped } from '../../src/scoped/commits.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  await putBlob(f.t.app, f.device.deviceToken, 'root')
  const root = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [create('Project/Root.md', 'root')])
  ).results[0]
  await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
  const group = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
    label: 'Project',
    root_file_id: root.file_id,
    expected_root_version: root.version_id,
    role: 'editor',
  })
  const key = await issueFolderKey(f.deps, f.owner.accountToken, f.vault, group.id, {
    attempt_id: 'project',
    name: 'Project',
    role: 'editor',
    expires_at: '2030-01-02T00:00:00.000Z',
  })
  await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
  await processGroupDirtyPage(f.deps, f.vault)
  return { ...f, root, group, key }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `v4 cross-grant adversarial server (${dialect})`,
    () => {
      it('permits legitimate Agents native creation while an agent group link and later owner save never publish it to Project', async () => {
        const f = await fixture(dialect)
        try {
          const text = '---\ngroups: ["[[Project/Root.md]]"]\n---\nagent'
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf(text),
            Buffer.from(text)
          )
          const first = (
            await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'agent-create', [
              create('Agents/agent.md', text),
            ])
          ).results[0]!
          await processGroupDirtyPage(f.deps, f.vault)
          await putBlob(f.t.app, f.device.deviceToken, text + '\nowner body')
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: first.version_id,
              sha: shaOf(text + '\nowner body'),
              size: Buffer.byteLength(text + '\nowner body'),
              mtime: 2,
            },
          ])
          await processGroupDirtyPage(f.deps, f.vault)
          expect(
            (await openFolderSnapshot(f.deps, f.key.key_token, f.vault, f.group.id)).items.map(
              (item) => item.file_id
            )
          ).not.toContain(first.file_id)
          const latest = await f.t.db
            .selectFrom('scope_group_parse_facts')
            .select('facts')
            .where('file_id', '=', first.file_id)
            .orderBy('committed_seq', 'desc')
            .executeTakeFirstOrThrow()
          expect(JSON.parse(latest.facts).memory['project/root.md'].origin.kind).toBe('recipient')
        } finally {
          await f.close()
        }
      })
      it('never adopts a hidden identical binary or creates Project notes inside the Agents audience', async () => {
        const f = await fixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'image')
          const hidden = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Attachments/private.png', 'image'),
            ])
          ).results[0]
          await processGroupDirtyPage(f.deps, f.vault)
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.group.id,
            shaOf('image'),
            Buffer.from('image')
          )
          await expect(
            commitScoped(f.deps, f.key.key_token, f.vault, f.group.id, 'adopt-private', [
              { ...create('Attachments/private.png', 'image'), sponsor_note_id: f.root.file_id },
            ])
          ).rejects.toMatchObject({ code: 'not_found' })
          await expect(
            commitScoped(f.deps, f.key.key_token, f.vault, f.group.id, 'cross-folder', [
              create('Agents/attack.md', 'image'),
            ])
          ).rejects.toMatchObject({ code: 'not_found' })
          expect(
            await f.t.db
              .selectFrom('scope_native_files')
              .select('file_id')
              .where('file_id', '=', hidden.file_id)
              .execute()
          ).toEqual([])
        } finally {
          await f.close()
        }
      })
      it('does not turn a native visible member into a propagation anchor on later owner edits', async () => {
        const f = await fixture(dialect)
        try {
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.group.id,
            shaOf('native'),
            Buffer.from('native')
          )
          const native = (
            await commitScoped(f.deps, f.key.key_token, f.vault, f.group.id, 'native', [
              create('Project/Projects.md', 'native'),
            ])
          ).results[0]!
          await processGroupDirtyPage(f.deps, f.vault)
          if (native.status === 'acknowledged') throw new Error('expected native content')
          const resaved = (await f.deps.store.get(native.sha!)).toString() + '\nowner body'
          await putBlob(f.t.app, f.device.deviceToken, resaved)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: native.file_id,
              base_version_id: native.version_id,
              sha: shaOf(resaved),
              size: Buffer.byteLength(resaved),
              mtime: 2,
            },
          ])
          await processGroupDirtyPage(f.deps, f.vault)
          const privateText = '---\ngroups: ["[[Project/Projects.md]]"]\n---\nprivate'
          await putBlob(f.t.app, f.device.deviceToken, privateText)
          const hidden = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Private/secret.md', privateText),
            ])
          ).results[0]
          await processGroupDirtyPage(f.deps, f.vault)
          expect(
            (await openFolderSnapshot(f.deps, f.key.key_token, f.vault, f.group.id)).items.map(
              (item) => item.file_id
            )
          ).not.toContain(hidden.file_id)
          expect(
            await f.t.db
              .selectFrom('scope_group_anchors')
              .select('file_id')
              .where('file_id', '=', native.file_id)
              .execute()
          ).toEqual([])
        } finally {
          await f.close()
        }
      })
    }
  )
