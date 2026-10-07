import { describe, expect, it } from 'vitest'
import { caseKey } from '@abele/sync-protocol'
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
import { resolveGroupTarget } from '../../src/scoped/groups/bindings.js'
const paths = [
  ['Проект/Корень.md', 'Проект/Новое.md'],
  ['ΠΡΟΤΖΕΚΤ/ΟΣ.md', 'ΠΡΟΤΖΕΚΤ/ΝΕΟ.md'],
  ['Équipe/İRİS.md', 'Équipe/Autre.md'],
]
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `Unicode historical group keys (${dialect})`,
    () => {
      it('holds on missing historical canonical-key evidence rather than returning an unresolved origin that can be promoted', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'root')
          const root = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Проект/Корень.md', 'root'),
            ])
          ).results[0]
          await f.t.db
            .updateTable('versions')
            .set({ path_ci: null })
            .where('id', '=', root.version_id)
            .execute()
          await expect(
            f.t.db
              .transaction()
              .execute((tx) =>
                resolveGroupTarget(tx, f.vault, '[[проект/корень.md]]', {}, root.seq)
              )
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
        } finally {
          await f.close()
        }
      })
      for (const [oldPath, newPath] of paths)
        it(`preserves lagged recipient origin for ${oldPath} with differently cased tokens`, async () => {
          const f = await scopedFixture(dialect)
          try {
            await putBlob(f.t.app, f.device.deviceToken, 'root')
            const root = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [create(oldPath!, 'root')])
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
            await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
            await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
            await processGroupDirtyPage(f.deps, f.vault)
            const body = `---\ngroups: ["[[${caseKey(oldPath!)}]]"]\n---\nbody`
            await uploadScopedBlob(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              shaOf(body),
              Buffer.from(body)
            )
            const note = (
              await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'agent', [
                create('Agents/n.md', body),
              ])
            ).results[0]!
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: root.file_id,
                base_version_id: root.version_id,
                to_path: newPath!,
              },
            ])
            const rewritten = `---\ngroups: ["[[${newPath}]]"]\n---\nbody`
            await putBlob(f.t.app, f.device.deviceToken, rewritten)
            const changed = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                {
                  op: 'modify',
                  file_id: note.file_id,
                  base_version_id: note.version_id,
                  sha: shaOf(rewritten),
                  size: Buffer.byteLength(rewritten),
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
            expect(facts.memory[caseKey(newPath!)].origin.kind).toBe('recipient')
            expect(facts.memory[caseKey(newPath!)].targetId).toBe(root.file_id)
            expect(
              (await openFolderSnapshot(f.deps, key.key_token, f.vault, project.id)).items.map(
                (item) => item.file_id
              )
            ).not.toContain(note.file_id)
          } finally {
            await f.close()
          }
        })
    }
  )
