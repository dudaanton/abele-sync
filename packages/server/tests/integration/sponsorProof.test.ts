import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { readSponsoredAssets, addSponsoredAsset } from '../../src/scoped/assets.js'
import { readIntrinsicSponsorProof } from '../../src/scoped/sponsorProof.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { readScopedUploadProof, createNativeSponsoredAsset } from '../../src/scoped/nativeAssets.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `intrinsic sponsor wire proof (${dialect})`,
    () => {
      it('supplies first-publication proof after move-out/back without guessing generation or reading SQL', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'note')
          const note = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', 'note')])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          expect(
            (await readSponsoredAssets(f.deps, f.device.deviceToken, f.vault, f.grant.id)).entries
          ).toEqual([])
          const first = await readIntrinsicSponsorProof(
            f.deps,
            f.device.deviceToken,
            f.vault,
            f.grant.id,
            note.file_id
          )
          expect(first.sponsor).toMatchObject({
            fileId: note.file_id,
            versionId: note.version_id,
            inScope: true,
            intrinsic: true,
          })
          expect(
            await readIntrinsicSponsorProof(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              note.file_id
            )
          ).toEqual(first)
          const out = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: note.file_id,
                base_version_id: note.version_id,
                to_path: 'Private/n.md',
              },
            ])
          ).results[0]
          for (const token of [f.device.deviceToken, f.a.key_token])
            await expect(
              readIntrinsicSponsorProof(f.deps, token, f.vault, f.grant.id, note.file_id)
            ).rejects.toMatchObject({ code: 'not_found' })
          const back = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: note.file_id,
                base_version_id: out.version_id,
                to_path: 'Agents/n.md',
              },
            ])
          ).results[0]
          const proof = await readIntrinsicSponsorProof(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            note.file_id
          )
          expect(proof.sponsor.versionId).toBe(back.version_id)
          expect(proof.sponsor.admissionGeneration).toBeGreaterThan(
            first.sponsor.admissionGeneration
          )
          expect(
            await readIntrinsicSponsorProof(
              f.deps,
              f.device.deviceToken,
              f.vault,
              f.grant.id,
              note.file_id
            )
          ).toEqual(proof)
          await putBlob(f.t.app, f.device.deviceToken, 'owner-image')
          const image = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Attachments/owner.png', 'owner-image'),
            ])
          ).results[0]
          const view = await readSponsoredAssets(f.deps, f.device.deviceToken, f.vault, f.grant.id)
          const ownerAdd = {
            grantId: f.grant.id,
            expectedRevision: view.revision,
            withdrawalGeneration: view.withdrawalGeneration,
            intentId: 'first',
            decisionDeviceId: f.device.deviceId,
            target: {
              fileId: image.file_id,
              versionId: image.version_id,
              sha: shaOf('owner-image'),
              path: 'Attachments/owner.png',
              eligible: true,
            },
            sponsors: [proof.sponsor],
            reason: 'confirmed-existing',
          }
          await expect(
            addSponsoredAsset(f.deps, f.device.deviceToken, f.vault, f.grant.id, {
              ...ownerAdd,
              sponsors: [
                { ...proof.sponsor, admissionGeneration: first.sponsor.admissionGeneration },
              ],
            })
          ).rejects.toMatchObject({ code: 'conflict' })
          expect(
            (await addSponsoredAsset(f.deps, f.device.deviceToken, f.vault, f.grant.id, ownerAdd))
              .entries
          ).toHaveLength(1)
          await expect(
            readIntrinsicSponsorProof(f.deps, f.a.key_token, f.vault, f.grant.id, image.file_id)
          ).rejects.toMatchObject({ code: 'not_found' })
          const sha = shaOf('native-image')
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            sha,
            Buffer.from('native-image')
          )
          const upload = await readScopedUploadProof(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            sha
          )
          const native = await createNativeSponsoredAsset(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            {
              grantId: f.grant.id,
              path: 'Attachments/native.png',
              localCreateHandle: 'native',
              sha,
              eligible: true,
              sponsor: proof.sponsor,
              upload: {
                principalId: f.a.key_id,
                grantId: f.grant.id,
                sha,
                entitlementId: upload.entitlementId,
              },
            }
          )
          expect(native.fileId).toBeTruthy()
        } finally {
          await f.close()
        }
      })
      it('denies hidden/foreign/non-note/preparing and wrong facet/role/revoked proof reads without leaking generations', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'note')
          const note = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', 'note')])
          ).results[0]
          await expect(
            readIntrinsicSponsorProof(
              f.deps,
              f.device.deviceToken,
              f.vault,
              f.grant.id,
              note.file_id
            )
          ).rejects.toMatchObject({ code: 'scope_updating' })
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          for (const id of ['missing', 'foreign'])
            await expect(
              readIntrinsicSponsorProof(f.deps, f.a.key_token, f.vault, f.grant.id, id)
            ).rejects.toMatchObject({ code: 'not_found' })
          await expect(
            readIntrinsicSponsorProof(
              f.deps,
              f.owner.accountToken,
              f.vault,
              f.grant.id,
              note.file_id
            )
          ).rejects.toMatchObject({ code: 'unauthorized' })
          await expect(
            readIntrinsicSponsorProof(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              note.file_id,
              'owner'
            )
          ).rejects.toMatchObject({ code: 'unauthorized' })
          await expect(
            readIntrinsicSponsorProof(
              f.deps,
              f.device.deviceToken,
              f.vault,
              f.grant.id,
              note.file_id,
              'scoped'
            )
          ).rejects.toMatchObject({ code: 'unauthorized' })
          const reader = await f.issue('reader', 'reader')
          await expect(
            readIntrinsicSponsorProof(f.deps, reader.key_token, f.vault, f.grant.id, note.file_id)
          ).rejects.toMatchObject({ code: 'forbidden' })
          await f.revoke(f.a.key_id)
          await expect(
            readIntrinsicSponsorProof(f.deps, f.a.key_token, f.vault, f.grant.id, note.file_id)
          ).rejects.toMatchObject({ code: 'unauthorized' })
        } finally {
          await f.close()
        }
      })
    }
  )
