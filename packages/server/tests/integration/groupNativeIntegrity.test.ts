import { describe, expect, it, vi } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { readScopedUploadProof, createNativeSponsoredAsset } from '../../src/scoped/nativeAssets.js'
import * as commits from '../../src/scoped/commits.js'
async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  await putBlob(f.t.app, f.device.deviceToken, 'note')
  const note = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
  ).results[0]
  await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
  const interval = await f.t.db
    .selectFrom('scope_admission_intervals')
    .select('generation')
    .where('file_id', '=', note.file_id)
    .where('ended_at', 'is', null)
    .executeTakeFirstOrThrow()
  const sha = shaOf('image')
  await uploadScopedBlob(f.deps, f.a.key_token, f.vault, f.grant.id, sha, Buffer.from('image'))
  const proof = await readScopedUploadProof(f.deps, f.a.key_token, f.vault, f.grant.id, sha)
  const request = {
    grantId: f.grant.id,
    path: 'Attachments/new.png',
    localCreateHandle: 'native-one',
    sha,
    eligible: true,
    sponsor: {
      fileId: note.file_id,
      versionId: note.version_id,
      admissionGeneration: interval.generation,
      inScope: true,
      intrinsic: true,
    },
    upload: {
      principalId: f.a.key_id,
      grantId: f.grant.id,
      sha,
      entitlementId: proof.entitlementId,
    },
  }
  return { ...f, note, request }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`group native integrity (${dialect})`, () => {
    it('does not consume E2 with a checked E1 proof across the preflight/commit boundary', async () => {
      const f = await fixture(dialect),
        original = commits.commitScoped
      try {
        const spy = vi.spyOn(commits, 'commitScoped').mockImplementationOnce(async (...args) => {
          f.setClock('2030-01-01T00:00:01.000Z')
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            f.request.sha,
            Buffer.from('image')
          )
          return original(...args)
        })
        await expect(
          createNativeSponsoredAsset(f.deps, f.a.key_token, f.vault, f.grant.id, f.request)
        ).rejects.toMatchObject({ code: 'not_found' })
        spy.mockRestore()
        expect(
          await f.t.db
            .selectFrom('scope_blob_uploads')
            .select(['created_at', 'expires_at'])
            .execute()
        ).toEqual([
          { created_at: '2030-01-01T00:00:00.000Z', expires_at: '2030-01-02T00:00:01.000Z' },
        ])
        expect(await f.t.db.selectFrom('scope_extra_entries').select('id').execute()).toHaveLength(
          0
        )
        expect(
          await f.t.db.selectFrom('scope_receipts').select('request_id').execute()
        ).toHaveLength(0)
      } finally {
        vi.restoreAllMocks()
        await f.close()
      }
    })
    it('restores and renames a retained external folder-native identity only with its independent live sponsor', async () => {
      const f = await fixture(dialect)
      try {
        const asset = await createNativeSponsoredAsset(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          f.request
        )
        await commits.commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'delete', [
          { op: 'delete', file_id: asset.fileId, base_version_id: asset.versionId },
        ])
        const restored = (
          await commits.commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'restore', [
            { op: 'restore', file_id: asset.fileId, version_id: asset.versionId },
          ])
        ).results[0]!
        const moved = (
          await commits.commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'move', [
            {
              op: 'move',
              file_id: asset.fileId,
              base_version_id: restored.version_id,
              to_path: 'Attachments/renamed.png',
            },
          ])
        ).results[0]!
        expect(moved.file_id).toBe(asset.fileId)
        await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          asset.fileId,
          moved.version_id
        )
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: f.note.file_id,
            base_version_id: f.note.version_id,
            to_path: 'Private/note.md',
          },
        ])
        await expect(
          commits.commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'after-departure', [
            {
              op: 'move',
              file_id: asset.fileId,
              base_version_id: moved.version_id,
              to_path: 'Attachments/private.png',
            },
          ])
        ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
  })
