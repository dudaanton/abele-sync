import { describe, expect, it, vi } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { readScopedUploadProof, createNativeSponsoredAsset } from '../../src/scoped/nativeAssets.js'
vi.mock('../../src/scoped/resourceLimits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/scoped/resourceLimits.js')>()),
  SCOPED_RESOURCE_LIMITS: {
    ...(await importOriginal<typeof import('../../src/scoped/resourceLimits.js')>())
      .SCOPED_RESOURCE_LIMITS,
    liveExtraEntries: 1,
  },
}))
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`native API budget (${dialect})`, () => {
    it('enforces the shared extra-entry ceiling through the folder native API, preserving rejected entitlement and receipt atomicity', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const note = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', 'note')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const interval = await f.t.db
          .selectFrom('scope_admission_intervals')
          .select('generation')
          .where('file_id', '=', note.file_id)
          .where('ended_at', 'is', null)
          .executeTakeFirstOrThrow()
        async function request(name: string) {
          const sha = shaOf(name)
          await uploadScopedBlob(f.deps, f.a.key_token, f.vault, f.grant.id, sha, Buffer.from(name))
          const proof = await readScopedUploadProof(f.deps, f.a.key_token, f.vault, f.grant.id, sha)
          return {
            grantId: f.grant.id,
            path: `Attachments/${name}.png`,
            localCreateHandle: name,
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
        }
        await createNativeSponsoredAsset(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          await request('one')
        )
        await expect(
          createNativeSponsoredAsset(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            await request('two')
          )
        ).rejects.toMatchObject({ code: 'too_large' })
        expect(await f.t.db.selectFrom('scope_extra_entries').select('id').execute()).toHaveLength(
          1
        )
        expect(await f.t.db.selectFrom('scope_receipts').select('request_id').execute()).toEqual([
          { request_id: 'one' },
        ])
        expect(await f.t.db.selectFrom('scope_blob_uploads').select('sha').execute()).toEqual([
          { sha: shaOf('two') },
        ])
      } finally {
        await f.close()
      }
    })
  })
