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
const text = (root = 'Project/Root.md', body = 'body') =>
  `---\ngroups: ["[[${root}]]"]\n---\n${body}`
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`group source authority (${dialect})`, () => {
    it('attributes lagged old/new rename spellings to one recipient identity instead of a new owner edge', async () => {
      const f = await fixture(dialect)
      try {
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf(text()),
          Buffer.from(text())
        )
        const note = (
          await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'agent', [
            create('Agents/a.md', text()),
          ])
        ).results[0]!
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: f.root.file_id,
            base_version_id: f.root.version_id,
            to_path: 'Project/Renamed.md',
          },
        ])
        const rewritten = text('Project/Renamed.md')
        await putBlob(f.t.app, f.device.deviceToken, rewritten)
        const changed = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: note.file_id,
              base_version_id: note.version_id,
              sha: shaOf(rewritten),
              size: rewritten.length,
              mtime: 2,
            },
          ])
        ).results[0]
        await processGroupDirtyPage(f.deps, f.vault)
        const facts = JSON.parse(
          (
            await f.t.db
              .selectFrom('scope_group_parse_facts')
              .select('facts')
              .where('version_id', '=', changed.version_id)
              .executeTakeFirstOrThrow()
          ).facts
        )
        expect(facts.memory['project/renamed.md'].origin.kind).toBe('recipient')
        expect(
          (await openFolderSnapshot(f.deps, f.key.key_token, f.vault, f.project.id)).items.map(
            (item) => item.file_id
          )
        ).not.toContain(note.file_id)
      } finally {
        await f.close()
      }
    })
    it('does not let the folder recipient undo a confirmed owner token removal', async () => {
      const f = await fixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, text())
        const note = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/a.md', text())])
        ).results[0]
        await processGroupDirtyPage(f.deps, f.vault)
        await putBlob(f.t.app, f.device.deviceToken, 'owner removed groups')
        const removed = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: note.file_id,
              base_version_id: note.version_id,
              sha: shaOf('owner removed groups'),
              size: 20,
              mtime: 2,
            },
          ])
        ).results[0]
        await processGroupDirtyPage(f.deps, f.vault)
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf(text()),
          Buffer.from(text())
        )
        const reintroduced = (
          await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'undo-withdrawal', [
            {
              op: 'modify',
              file_id: note.file_id,
              base_version_id: removed.version_id,
              sha: shaOf(text()),
              size: text().length,
              mtime: 3,
            },
          ])
        ).results[0]!
        await processGroupDirtyPage(f.deps, f.vault)
        const facts = JSON.parse(
          (
            await f.t.db
              .selectFrom('scope_group_parse_facts')
              .select('facts')
              .where('version_id', '=', reintroduced.version_id)
              .executeTakeFirstOrThrow()
          ).facts
        )
        expect(facts.memory['project/root.md'].origin.kind).toBe('recipient')
        expect(
          (await openFolderSnapshot(f.deps, f.key.key_token, f.vault, f.project.id)).items.map(
            (item) => item.file_id
          )
        ).not.toContain(note.file_id)
      } finally {
        await f.close()
      }
    })
    it('cannot turn sponsored text bytes into intrinsic sponsor authority by renaming .png to .md inside one atomic unit', async () => {
      const f = await fixture(dialect)
      try {
        await uploadScopedBlob(
          f.deps,
          f.key.key_token,
          f.vault,
          f.project.id,
          shaOf('plain text'),
          Buffer.from('plain text')
        )
        const image = (
          await commitScoped(f.deps, f.key.key_token, f.vault, f.project.id, 'image', [
            { ...create('Attachments/x.png', 'plain text'), sponsor_note_id: f.root.file_id },
          ])
        ).results[0]!
        await processGroupDirtyPage(f.deps, f.vault)
        await uploadScopedBlob(
          f.deps,
          f.key.key_token,
          f.vault,
          f.project.id,
          shaOf('other'),
          Buffer.from('other')
        )
        const before = await f.t.db.selectFrom('versions').select('id').execute()
        await expect(
          commitScoped(f.deps, f.key.key_token, f.vault, f.project.id, 'chain', [
            {
              op: 'move',
              file_id: image.file_id,
              base_version_id: image.version_id,
              to_path: 'Attachments/x.md',
            },
            { ...create('Attachments/y.png', 'other'), sponsor_note_id: image.file_id },
          ])
        ).rejects.toMatchObject({ code: 'not_found' })
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual(before)
      } finally {
        await f.close()
      }
    })
  })
