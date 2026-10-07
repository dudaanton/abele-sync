import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import {
  readSponsoredAssets,
  addSponsoredAsset,
  mutateSponsoredAssets,
} from '../../src/scoped/assets.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `owner-device sponsored assets (${dialect})`,
    () => {
      it('publishes exact eligible targets only from the current owner device with mandatory intrinsic sponsors and CAS/withdrawal replay', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'note')
          const note = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
          ).results[0]
          const sha = await putBlob(f.t.app, f.device.deviceToken, 'image')
          const target = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Attachments/image.png', 'image'),
            ])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          const interval = await f.t.db
            .selectFrom('scope_admission_intervals')
            .select('generation')
            .where('file_id', '=', note.file_id)
            .where('ended_at', 'is', null)
            .executeTakeFirstOrThrow()
          const view = await readSponsoredAssets(f.deps, f.device.deviceToken, f.vault, f.grant.id)
          const input = {
            grantId: f.grant.id,
            expectedRevision: view.revision,
            withdrawalGeneration: view.withdrawalGeneration,
            intentId: 'publish',
            decisionDeviceId: f.device.deviceId,
            target: {
              fileId: target.file_id,
              versionId: target.version_id,
              sha,
              path: 'Attachments/image.png',
              eligible: true,
            },
            sponsors: [
              {
                fileId: note.file_id,
                versionId: note.version_id,
                admissionGeneration: interval.generation,
                inScope: true,
                intrinsic: true,
              },
            ],
            reason: 'confirmed-existing',
          }
          await expect(
            addSponsoredAsset(f.deps, f.a.key_token, f.vault, f.grant.id, input)
          ).rejects.toMatchObject({ code: 'unauthorized' })
          const published = await addSponsoredAsset(
            f.deps,
            f.device.deviceToken,
            f.vault,
            f.grant.id,
            input
          )
          expect(published.entries[0]?.kind).toBe('owner-extra')
          await requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            target.file_id,
            target.version_id
          )
          await expect(
            addSponsoredAsset(f.deps, f.device.deviceToken, f.vault, f.grant.id, {
              ...input,
              intentId: 'stale',
            })
          ).rejects.toMatchObject({ code: 'conflict' })
          const withdrawn = await mutateSponsoredAssets(
            f.deps,
            f.device.deviceToken,
            f.vault,
            f.grant.id,
            {
              expectedRevision: published.revision,
              intentId: 'unshare',
              delta: {
                kind: 'withdraw',
                fileId: target.file_id,
                expectedGeneration: published.withdrawalGeneration,
              },
            }
          )
          expect(withdrawn.entries).toEqual([])
          expect(withdrawn.withdrawalGeneration).toBeGreaterThan(published.withdrawalGeneration)
          expect(
            (await addSponsoredAsset(f.deps, f.device.deviceToken, f.vault, f.grant.id, input))
              .entries
          ).toEqual([])
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              target.file_id,
              target.version_id
            )
          ).rejects.toMatchObject({ code: 'not_found' })
        } finally {
          await f.close()
        }
      })
    }
  )
