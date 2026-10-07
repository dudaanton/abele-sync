import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { createGroupGrant, updateGroupGrant } from '../../src/auth/groupManagement.js'
import { issueFolderKey } from '../../src/auth/folderManagement.js'
import { prepareGroupBootstrap, rebuildGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
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
    for (const recovery of ['renewal', 'reviewed rebuild'] as const)
      it(`requires fresh audience approval after an unproven history gap (${recovery})`, async () => {
        const f = await fixture(dialect)
        try {
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          let attempt = 0
          const recipientSave = async (previous?: { file_id: string; version_id: string }) => {
            const text = body(`recipient edit ${attempt++}`)
            await uploadScopedBlob(
              f.deps,
              f.folderKey.key_token,
              f.vault,
              f.grant.id,
              shaOf(text),
              Buffer.from(text)
            )
            const result = (
              await commitScoped(
                f.deps,
                f.folderKey.key_token,
                f.vault,
                f.grant.id,
                `recipient-${attempt}`,
                [
                  previous
                    ? {
                        op: 'modify',
                        file_id: previous.file_id,
                        base_version_id: previous.version_id,
                        sha: shaOf(text),
                        size: Buffer.byteLength(text),
                        mtime: attempt,
                      }
                    : create('Agents/Note.md', text),
                ]
              )
            ).results[0]!
            if (result.status === 'rejected')
              throw new Error(`recipient edit rejected: ${JSON.stringify(result)}`)
            return result
          }
          const initial = await recipientSave()
          await processGroupDirtyPage(f.deps, f.vault)
          const approve = (source: typeof initial, revision: number) =>
            approveGroupRelation(f.deps, f.owner.accountToken, f.vault, f.a.grant.id, {
              device_token: f.device.deviceToken,
              expected_revision: revision,
              source_file_id: source.file_id,
              source_version_id: source.version_id,
              target_file_id: f.root.file_id,
              target_version_id: f.root.version_id,
              token_key: 'root.md',
            })
          await approve(initial, 0)
          await requireFolderVersion(
            f.deps,
            f.a.key.key_token,
            f.vault,
            f.a.grant.id,
            initial.file_id,
            initial.version_id
          )
          if (recovery === 'renewal') {
            await updateGroupGrant(f.deps, f.owner.accountToken, f.vault, f.a.grant.id, {
              expected_revision: 1,
              expires_at: '2030-01-01T00:01:00.000Z',
            })
            f.setClock('2030-01-01T00:02:00.000Z')
          }
          // Owner withdrawal is followed by recipient reintroduction, outside
          // the next bootstrap's 128-version chain. The folder grant stays live.
          let current = await f.modify(initial, 'owner withdrew the group token')
          for (let index = 0; index < 130; index++) current = await recipientSave(current)
          if (recovery === 'renewal') {
            expect(
              await f.t.db
                .selectFrom('scope_group_dirty')
                .select('version_id')
                .where('version_id', '=', current.version_id)
                .execute()
            ).toEqual([])
            await updateGroupGrant(f.deps, f.owner.accountToken, f.vault, f.a.grant.id, {
              expected_revision: 2,
              expires_at: '2030-01-02T00:00:00.000Z',
            })
          } else await rebuildGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 0)
          await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
          expect((await processGroupDirtyPage(f.deps, f.vault)).ready).toBe(true)
          expect(
            await f.t.db
              .selectFrom('scope_group_parse_facts')
              .select('status')
              .where('version_id', '=', current.version_id)
              .executeTakeFirstOrThrow()
          ).toEqual({ status: 'unknown' })
          current = await recipientSave(current)
          await processGroupDirtyPage(f.deps, f.vault)
          const fact = await f.t.db
            .selectFrom('scope_group_parse_facts')
            .select(['status', 'facts'])
            .where('version_id', '=', current.version_id)
            .executeTakeFirstOrThrow()
          expect(fact.status).toBe('valid')
          expect(JSON.parse(fact.facts).memory['root.md'].origin.kind).toBe('unknown')
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key.key_token,
              f.vault,
              f.a.grant.id,
              current.file_id,
              current.version_id
            )
          ).rejects.toMatchObject({ code: 'not_found' })
          // A fresh exact-preview approval is allowed, without upgrading provenance.
          await approve(current, recovery === 'renewal' ? 3 : 1)
          await requireFolderVersion(
            f.deps,
            f.a.key.key_token,
            f.vault,
            f.a.grant.id,
            current.file_id,
            current.version_id
          )
        } finally {
          await f.close()
        }
      }, 120_000)

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
