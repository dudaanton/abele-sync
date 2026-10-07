import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import { issueFolderKey } from '../../src/auth/folderManagement.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { commitScoped } from '../../src/scoped/commits.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  await putBlob(f.t.app, f.device.deviceToken, 'root')
  const root = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [create('Project/Root.md', 'root')])
  ).results[0]
  const grant = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
    label: 'Project',
    root_file_id: root.file_id,
    expected_root_version: root.version_id,
    role: 'editor',
  })
  const key = await issueFolderKey(f.deps, f.owner.accountToken, f.vault, grant.id, {
    attempt_id: 'project',
    name: 'Project',
    role: 'editor',
    expires_at: '2030-01-02T00:00:00.000Z',
  })
  await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
  await processGroupDirtyPage(f.deps, f.vault)
  return { ...f, root, project: grant, key }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `authorized native group writes (${dialect})`,
    () => {
      it('creates exact-path root-only native notes and sponsored external images without adopting hidden identities', async () => {
        const f = await fixture(dialect)
        try {
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            shaOf('new body'),
            Buffer.from('new body')
          )
          const created = await commitScoped(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            'new-note',
            [create('Project/New.md', 'new body')]
          )
          const note = created.results[0]!
          expect(note.status).toBe('applied')
          if (note.status === 'acknowledged') throw new Error('expected native content')
          const bytes = (await f.deps.store.get(note.sha!)).toString()
          expect(bytes).toContain('Project/Root.md')
          expect(bytes).toContain('new body')
          await processGroupDirtyPage(f.deps, f.vault)
          expect(
            (
              await f.t.db
                .selectFrom('scope_group_origins')
                .select('origin_kind')
                .where('source_file_id', '=', note.file_id)
                .execute()
            )[0]?.origin_kind
          ).toBe('grant_native')
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            shaOf('image'),
            Buffer.from('image')
          )
          const image = await commitScoped(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            'native-image',
            [{ ...create('Attachments/new.png', 'image'), sponsor_note_id: note.file_id }]
          )
          expect(image.results[0]).toMatchObject({ status: 'applied', path: 'Attachments/new.png' })
          await processGroupDirtyPage(f.deps, f.vault)
          expect(
            (
              await f.t.db
                .selectFrom('scope_extra_entries')
                .select('origin')
                .where('file_id', '=', image.results[0]!.file_id)
                .executeTakeFirstOrThrow()
            ).origin
          ).toBe('native')
        } finally {
          await f.close()
        }
      })
      it('allows ordinary body merging but refuses root-field edits and another folder destination', async () => {
        const f = await fixture(dialect)
        try {
          const text = '---\ngroups: ["[[Project/Root.md]]"]\n---\na\nb\nc\n'
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            shaOf(text),
            Buffer.from(text)
          )
          const first = (
            await commitScoped(f.deps, f.key.key_token, f.vault, f.project.id, 'first', [
              create('Project/Note.md', text),
            ])
          ).results[0]!
          await processGroupDirtyPage(f.deps, f.vault)
          const body = text.replace('a\nb', 'A\nb')
          await putBlob(f.t.app, f.device.deviceToken, body)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: first.version_id,
              sha: shaOf(body),
              size: body.length,
              mtime: 2,
            },
          ])
          await processGroupDirtyPage(f.deps, f.vault)
          const incoming = text.replace('b\nc', 'b\nC')
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            shaOf(incoming),
            Buffer.from(incoming)
          )
          const merged = await commitScoped(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            'merge',
            [
              {
                op: 'modify',
                file_id: first.file_id,
                base_version_id: first.version_id,
                sha: shaOf(incoming),
                size: incoming.length,
                mtime: 3,
              },
            ]
          )
          expect(merged.results[0]?.status).toBe('merged')
          await processGroupDirtyPage(f.deps, f.vault)
          const malicious = '---\ngroups: ["[[Private/Root]]"]\n---\nbody'
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.project.id,
            shaOf(malicious),
            Buffer.from(malicious)
          )
          await expect(
            commitScoped(f.deps, f.key.key_token, f.vault, f.project.id, 'root-change', [
              {
                op: 'modify',
                file_id: first.file_id,
                base_version_id: merged.results[0]!.version_id,
                sha: shaOf(malicious),
                size: malicious.length,
                mtime: 4,
              },
            ])
          ).rejects.toMatchObject({ code: 'forbidden' })
          await expect(
            commitScoped(f.deps, f.key.key_token, f.vault, f.project.id, 'cross-folder', [
              {
                op: 'move',
                file_id: first.file_id,
                base_version_id: merged.results[0]!.version_id,
                to_path: 'Agents/attack.md',
              },
            ])
          ).rejects.toMatchObject({ code: 'not_found' })
        } finally {
          await f.close()
        }
      })
    }
  )
