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
import { readIntrinsicSponsorProof } from '../../src/scoped/sponsorProof.js'
import { readSponsoredAssets, addSponsoredAsset } from '../../src/scoped/assets.js'
import { runRetention } from '../../src/history/retention.js'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
const grouped = (body = 'body') => `---\ngroups: ["[[Project/Root.md]]"]\n---\n${body}`
async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  await putBlob(f.t.app, f.device.deviceToken, 'root')
  const root = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [create('Project/Root.md', 'root')])
  ).results[0]
  const group = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
    label: 'Project',
    root_file_id: root.file_id,
    expected_root_version: root.version_id,
    role: 'editor',
  })
  const key = await issueFolderKey(f.deps, f.owner.accountToken, f.vault, group.id, {
    attempt_id: 'project',
    name: 'project',
    role: 'editor',
    expires_at: '2030-01-02T00:00:00.000Z',
  })
  await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
  await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
  await processGroupDirtyPage(f.deps, f.vault)
  const save = async (file: any, text: string) => {
    await putBlob(f.t.app, f.device.deviceToken, text)
    return (
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'modify',
          file_id: file.file_id,
          base_version_id: file.version_id,
          sha: shaOf(text),
          size: text.length,
          mtime: 2,
        },
      ])
    ).results[0]
  }
  const facts = async (version: string) =>
    JSON.parse(
      (
        await f.t.db
          .selectFrom('scope_group_parse_facts')
          .select('facts')
          .where('version_id', '=', version)
          .executeTakeFirstOrThrow()
      ).facts
    )
  return { ...f, root, group, key, save, facts }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `scoped write and publication origins (${dialect})`,
    () => {
      it('does not carry owner group authority onto a new folder-recipient conflict identity', async () => {
        const f = await fixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, grouped())
          const note = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', grouped())])
          ).results[0]
          await processGroupDirtyPage(f.deps, f.vault)
          const settings = await f.t.db
            .selectFrom('vaults')
            .select('settings')
            .where('id', '=', f.vault)
            .executeTakeFirstOrThrow()
          await f.t.db
            .updateTable('vaults')
            .set({
              settings: JSON.stringify({
                ...JSON.parse(settings.settings),
                conflict: 'conflict-file',
              }),
            })
            .where('id', '=', f.vault)
            .execute()
          await f.save(note, grouped('owner'))
          await processGroupDirtyPage(f.deps, f.vault)
          const incoming = grouped('agent')
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf(incoming),
            Buffer.from(incoming)
          )
          const result = (
            await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'conflict', [
              {
                op: 'modify',
                file_id: note.file_id,
                base_version_id: note.version_id,
                sha: shaOf(incoming),
                size: incoming.length,
                mtime: 3,
              },
            ])
          ).results[0]!
          expect(result.status).toBe('conflict')
          if (result.status !== 'conflict') throw new Error('conflict required')
          await processGroupDirtyPage(f.deps, f.vault)
          expect(
            (await f.facts(result.conflict_version_id)).memory['project/root.md'].origin.kind
          ).toBe('recipient')
          expect(
            await f.t.db
              .selectFrom('scope_current_members')
              .select('file_id')
              .where('grant_id', '=', f.group.id)
              .where('file_id', '=', result.conflict_file_id)
              .execute()
          ).toEqual([])
          expect(
            await f.t.db
              .selectFrom('scope_current_members')
              .select('file_id')
              .where('grant_id', '=', f.group.id)
              .where('file_id', '=', note.file_id)
              .execute()
          ).toHaveLength(1)
        } finally {
          await f.close()
        }
      })
      it('rechecks base/fact completeness after lease expiry and real GC before treating an old edge as an owner addition', async () => {
        const f = await fixture(dialect)
        try {
          const body = grouped()
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf(body),
            Buffer.from(body)
          )
          const b = (
            await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'agent', [
              create('Agents/n.md', body),
            ])
          ).results[0]!
          await processGroupDirtyPage(f.deps, f.vault)
          f.setClock('2030-01-01T23:59:50.000Z')
          const h = await f.save(b, 'owner removed groups')
          await processGroupDirtyPage(f.deps, f.vault)
          const d = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              { op: 'delete', file_id: b.file_id, base_version_id: h.version_id },
            ])
          ).results[0]
          await processGroupDirtyPage(f.deps, f.vault)
          const n = await f.save(b, grouped('offline owner body edit'))
          const settings = await f.t.db
            .selectFrom('vaults')
            .select('settings')
            .where('id', '=', f.vault)
            .executeTakeFirstOrThrow()
          await f.t.db
            .updateTable('vaults')
            .set({
              settings: JSON.stringify({
                ...JSON.parse(settings.settings),
                retention: { notes_days: 1, attachments_days: 1, settings_days: 1 },
              }),
            })
            .where('id', '=', f.vault)
            .execute()
          f.setClock('2030-01-02T00:06:00.000Z')
          const config = loadConfig({
            ABELE_MASTER_KEY: 'ab'.repeat(32),
            ABELE_TOKEN_PEPPER: 'test',
            ABELE_BLOB_DIR: f.t.store.dir,
          })
          await runRetention({
            ...f.deps,
            uploads: createUploadManager({ ...f.deps, config }),
            idempotencyTtlMs: 86400000,
          })
          expect(
            await f.t.db
              .selectFrom('versions')
              .select('id')
              .where('id', '=', b.version_id)
              .execute()
          ).toEqual([])
          expect(
            await f.t.db
              .selectFrom('versions')
              .select('id')
              .where('id', 'in', [d.version_id, n.version_id])
              .execute()
          ).toHaveLength(2)
          await processGroupDirtyPage(f.deps, f.vault)
          const facts = await f.facts(n.version_id)
          expect(facts.uncertain).toBe(true)
          expect(facts.active).toEqual([])
          expect(
            await f.t.db
              .selectFrom('scope_current_members')
              .select('file_id')
              .where('grant_id', '=', f.group.id)
              .where('file_id', '=', b.file_id)
              .execute()
          ).toEqual([])
        } finally {
          await f.close()
        }
      })
      it('keeps native note groups protected while its extension changes to an extra-only attachment', async () => {
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
          const note = (
            await commitScoped(f.deps, f.key.key_token, f.vault, f.group.id, 'native', [
              create('Native/n.md', 'native'),
            ])
          ).results[0]!
          await processGroupDirtyPage(f.deps, f.vault)
          const source = await f.t.db
            .selectFrom('scope_current_members')
            .selectAll()
            .where('file_id', '=', note.file_id)
            .where('grant_id', '=', f.group.id)
            .executeTakeFirstOrThrow()
          const proof = await readIntrinsicSponsorProof(
              f.deps,
              f.device.deviceToken,
              f.vault,
              f.group.id,
              f.root.file_id
            ),
            view = await readSponsoredAssets(f.deps, f.device.deviceToken, f.vault, f.group.id)
          await addSponsoredAsset(f.deps, f.device.deviceToken, f.vault, f.group.id, {
            grantId: f.group.id,
            expectedRevision: view.revision,
            withdrawalGeneration: view.withdrawalGeneration,
            intentId: 'sponsor-note',
            decisionDeviceId: f.device.deviceId,
            target: {
              fileId: note.file_id,
              versionId: note.version_id,
              sha: source.sha,
              path: source.path,
              eligible: true,
            },
            sponsors: [proof.sponsor],
            reason: 'confirmed-existing',
          })
          const moved = (
            await commitScoped(f.deps, f.key.key_token, f.vault, f.group.id, 'to-txt', [
              {
                op: 'move',
                file_id: note.file_id,
                base_version_id: note.version_id,
                to_path: 'Native/n.txt',
              },
            ])
          ).results[0]!
          await processGroupDirtyPage(f.deps, f.vault)
          const changed = grouped('attempt').replace('Project/Root.md', 'Another/Root.md')
          await uploadScopedBlob(
            f.deps,
            f.key.key_token,
            f.vault,
            f.group.id,
            shaOf(changed),
            Buffer.from(changed)
          )
          await expect(
            commitScoped(f.deps, f.key.key_token, f.vault, f.group.id, 'change-groups', [
              {
                op: 'modify',
                file_id: note.file_id,
                base_version_id: moved.version_id,
                sha: shaOf(changed),
                size: changed.length,
                mtime: 3,
              },
            ])
          ).rejects.toMatchObject({ code: 'forbidden' })
        } finally {
          await f.close()
        }
      })
    }
  )
