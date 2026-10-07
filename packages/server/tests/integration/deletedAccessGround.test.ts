import { describe, expect, it } from 'vitest'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { updateFolderGrant } from '../../src/auth/folderManagement.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`deleted access grounds (${dialect})`, () => {
    it('closes prior scoped trash when the owner changes the grant prefix', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'secret')
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/secret.md', 'secret'),
          ])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          { op: 'delete', file_id: head.file_id, base_version_id: head.version_id },
        ])
        await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          head.file_id,
          head.version_id
        )
        await updateFolderGrant(f.deps, f.owner.accountToken, f.vault, f.grant.id, {
          expected_revision: 0,
          prefix: 'Public/',
        })
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await expect(
          requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            head.file_id,
            head.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
    it('withdraws deleted extra history when its final sponsor leaves, even without a current-member row', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const sponsor = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/sponsor.md', 'note'),
          ])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'image')
        const image = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Attachments/image.png', 'image'),
          ])
        ).results[0]
        const interval = await f.t.db
          .selectFrom('scope_admission_intervals')
          .selectAll()
          .where('file_id', '=', sponsor.file_id)
          .where('ended_at', 'is', null)
          .executeTakeFirstOrThrow()
        await f.t.db
          .insertInto('scope_extra_entries')
          .values({
            id: 'extra',
            grant_id: f.grant.id,
            vault_id: f.vault,
            file_id: image.file_id,
            origin: 'owner',
            first_version_id: image.version_id,
            generation: 1,
            owner_device_id: f.device.deviceId,
            reason: 'initial_batch',
            created_at: f.deps.now().toISOString(),
            withdrawn_at: null,
          })
          .execute()
        await f.t.db
          .insertInto('scope_extra_sponsors')
          .values({
            entry_id: 'extra',
            grant_id: f.grant.id,
            vault_id: f.vault,
            note_id: sponsor.file_id,
            interval_id: interval.id,
            admission_generation: interval.generation,
            intrinsic: 1,
            added_at: f.deps.now().toISOString(),
          })
          .execute()
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          { op: 'delete', file_id: image.file_id, base_version_id: image.version_id },
        ])
        await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          image.file_id,
          image.version_id
        )
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: sponsor.file_id,
            base_version_id: sponsor.version_id,
            to_path: 'Private/sponsor.md',
          },
        ])
        await expect(
          requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            image.file_id,
            image.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
        expect(
          (
            await f.t.db
              .selectFrom('scope_trash')
              .select('eligible')
              .where('file_id', '=', image.file_id)
              .executeTakeFirstOrThrow()
          ).eligible
        ).toBe(0)
      } finally {
        await f.close()
      }
    })
  })
}
