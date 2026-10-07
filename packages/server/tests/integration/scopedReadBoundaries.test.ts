import { describe, expect, it } from 'vitest'
import { resolveGroupTarget } from '../../src/scoped/groups/bindings.js'
import { runRetention } from '../../src/history/retention.js'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import { issueFolderKey } from '../../src/auth/folderManagement.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import {
  beginScopedUpload,
  putScopedPart,
  completeScopedUpload,
} from '../../src/scoped/multipart.js'
import { commitScoped } from '../../src/scoped/commits.js'
async function quota(f: Awaited<ReturnType<typeof scopedFixture>>, bytes: number) {
  const row = await f.t.db
    .selectFrom('vaults')
    .select('settings')
    .where('id', '=', f.vault)
    .executeTakeFirstOrThrow()
  await f.t.db
    .updateTable('vaults')
    .set({ settings: JSON.stringify({ ...JSON.parse(row.settings), quota_bytes: bytes }) })
    .where('id', '=', f.vault)
    .execute()
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `scoped read and history boundaries (${dialect})`,
    () => {
      it('holds lost historical-target proof beyond 128 real edits instead of promoting recipient links on owner rewrite', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'root')
          let root = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Project/Root.md', 'root'),
            ])
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
          const body = '---\ngroups: ["[[Project/Root.md]]"]\n---\nprivate agent body'
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
          root = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: root.file_id,
                base_version_id: root.version_id,
                to_path: 'Project/Renamed.md',
              },
            ])
          ).results[0]
          for (let n = 0; n < 129; n++) {
            const text = `root ${n}`
            await putBlob(f.t.app, f.device.deviceToken, text)
            root = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                {
                  op: 'modify',
                  file_id: root.file_id,
                  base_version_id: root.version_id,
                  sha: shaOf(text),
                  size: text.length,
                  mtime: n + 2,
                },
              ])
            ).results[0]
          }
          const rewritten = body.replace('Project/Root.md', 'Project/Renamed.md')
          await putBlob(f.t.app, f.device.deviceToken, rewritten)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: note.file_id,
              base_version_id: note.version_id,
              sha: shaOf(rewritten),
              size: rewritten.length,
              mtime: 200,
            },
          ])
          await expect(processGroupDirtyPage(f.deps, f.vault, 1000)).rejects.toMatchObject({
            code: 'scope_unavailable',
          })
          expect(
            (
              await f.t.db
                .selectFrom('scope_group_progress')
                .select('status')
                .where('vault_id', '=', f.vault)
                .executeTakeFirstOrThrow()
            ).status
          ).toBe('unavailable')
          await expect(
            openFolderSnapshot(f.deps, key.key_token, f.vault, group.id)
          ).rejects.toMatchObject({ code: 'scope_updating' })
          expect(
            await f.t.db
              .selectFrom('scope_current_members')
              .select('file_id')
              .where('grant_id', '=', group.id)
              .where('file_id', '=', note.file_id)
              .execute()
          ).toEqual([])
        } finally {
          await f.close()
        }
      })
      it('holds an old-path target after actual GC removes its lookup row before lagged parse', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'root')
          const root = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Project/Root.md', 'root'),
            ])
          ).results[0]
          const group = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
            label: 'Project',
            root_file_id: root.file_id,
            expected_root_version: root.version_id,
            role: 'editor',
          })
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
          await processGroupDirtyPage(f.deps, f.vault)
          const body = '---\ngroups: ["[[Project/Root.md]]"]\n---\nrecipient'
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf(body),
            Buffer.from(body)
          )
          await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'agent', [
            create('Agents/n.md', body),
          ])
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: root.file_id,
              base_version_id: root.version_id,
              to_path: 'Project/Renamed.md',
            },
          ])
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
                retention: { notes_days: 0, attachments_days: 0, settings_days: 0 },
              }),
            })
            .where('id', '=', f.vault)
            .execute()
          f.setClock('2030-01-01T00:06:00.000Z')
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
              .where('id', '=', root.version_id)
              .execute()
          ).toEqual([])
          await expect(
            f.t.db
              .transaction()
              .execute((tx) => resolveGroupTarget(tx, f.vault, '[[Project/Root.md]]', {}, 2))
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
          await expect(processGroupDirtyPage(f.deps, f.vault, 1000)).rejects.toMatchObject({
            code: 'scope_unavailable',
          })
          expect(
            await f.t.db
              .selectFrom('scope_current_members')
              .select('file_id')
              .where('grant_id', '=', group.id)
              .where('path', '=', 'Agents/n.md')
              .execute()
          ).toEqual([])
        } finally {
          await f.close()
        }
      })
      for (const source of ['personal', 'other-scoped'] as const)
        it(`does not discount a ${source} private SHA at multipart begin before own byte proof`, async () => {
          const f = await scopedFixture(dialect)
          try {
            await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
            await quota(f, 10)
            const hidden = shaOf('secret')
            if (source === 'personal') await putBlob(f.t.app, f.device.deviceToken, 'secret')
            else
              await uploadScopedBlob(
                f.deps,
                f.b.key_token,
                f.vault,
                f.grant.id,
                hidden,
                Buffer.from('secret')
              )
            await expect(
              beginScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, shaOf('absent'), 6)
            ).rejects.toMatchObject({ code: 'quota_waiting' })
            await expect(
              beginScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, hidden, 6)
            ).rejects.toMatchObject({ code: 'quota_waiting' })
            expect(
              await f.t.db
                .selectFrom('scope_uploads')
                .select('id')
                .where('principal_id', '=', f.a.key_id)
                .execute()
            ).toEqual([])
            await uploadScopedBlob(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              hidden,
              Buffer.from('secret')
            )
            expect(
              (await beginScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, hidden, 6))
                .upload_id
            ).toBeTruthy()
          } finally {
            await f.close()
          }
        })
      it('rejects missing/mismatched/expired own create proof before any private live-usage limit response', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, '123456789')
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Private/n.md', '123456789'),
          ])
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await quota(f, 10)
          for (const size of [1, 2, 11])
            await expect(
              commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, `probe-${size}`, [
                { op: 'create', path: 'Agents/probe.bin', sha: shaOf('missing'), size, mtime: 1 },
              ])
            ).rejects.toMatchObject({ code: 'not_found' })
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('x'),
            Buffer.from('x')
          )
          await expect(
            commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'wrong-size', [
              { op: 'create', path: 'Agents/mismatch.bin', sha: shaOf('x'), size: 2, mtime: 1 },
            ])
          ).rejects.toMatchObject({ code: 'not_found' })
          await f.t.db
            .updateTable('scope_blob_uploads')
            .set({ created_at: '2029-12-31T00:00:00.000Z', expires_at: '2030-01-01T00:00:00.000Z' })
            .where('principal_id', '=', f.a.key_id)
            .execute()
          await expect(
            commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'expired-proof', [
              { op: 'create', path: 'Agents/expired.bin', sha: shaOf('x'), size: 1, mtime: 1 },
            ])
          ).rejects.toMatchObject({ code: 'not_found' })
          expect(await f.t.db.selectFrom('scope_receipts').select('request_id').execute()).toEqual(
            []
          )
          expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(1)
        } finally {
          await f.close()
        }
      })
      for (const candidate of ['secret', 'absent'])
        it(`does not use unverified multipart completion ${candidate} hash as a private-SHA budget probe`, async () => {
          const f = await scopedFixture(dialect)
          try {
            await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
            await quota(f, 20)
            const unknown = shaOf(candidate),
              upload = await beginScopedUpload(
                f.deps,
                f.a.key_token,
                f.vault,
                f.grant.id,
                unknown,
                6
              )
            await putScopedPart(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              upload.upload_id,
              0,
              Buffer.from('wrong!')
            )
            await putBlob(f.t.app, f.device.deviceToken, 'secret')
            await quota(f, 10)
            await expect(
              completeScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, upload.upload_id)
            ).rejects.toMatchObject({ code: 'hash_mismatch' })
            expect(
              await f.t.db
                .selectFrom('scope_blob_uploads')
                .select('sha')
                .where('principal_id', '=', f.a.key_id)
                .execute()
            ).toEqual([])
          } finally {
            await f.close()
          }
        })
    }
  )
