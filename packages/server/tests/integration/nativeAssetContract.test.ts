import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { readScopedUploadProof, createNativeSponsoredAsset } from '../../src/scoped/nativeAssets.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `native asset client contract (${dialect})`,
    () => {
      it('creates a fresh external asset with intrinsic sponsor/proof and replays without a new entitlement or identity', async () => {
        const f = await scopedFixture(dialect)
        try {
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
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            sha,
            Buffer.from('image')
          )
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
          await expect(
            createNativeSponsoredAsset(f.deps, f.b.key_token, f.vault, f.grant.id, request)
          ).rejects.toMatchObject({ code: 'not_found' })
          const result = await createNativeSponsoredAsset(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            request
          )
          expect(
            await createNativeSponsoredAsset(f.deps, f.a.key_token, f.vault, f.grant.id, request)
          ).toEqual(result)
          await requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            result.fileId,
            result.versionId
          )
          expect(
            (
              await f.t.db
                .selectFrom('scope_extra_entries')
                .select('origin')
                .where('file_id', '=', result.fileId)
                .executeTakeFirstOrThrow()
            ).origin
          ).toBe('native')
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: note.file_id,
              base_version_id: note.version_id,
              to_path: 'Private/note.md',
            },
          ])
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              result.fileId,
              result.versionId
            )
          ).rejects.toMatchObject({ code: 'not_found' })
        } finally {
          await f.close()
        }
      })
    }
  )
