import { describe, expect, it } from 'vitest'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { updateFolderGrant } from '../../src/auth/folderManagement.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`folder admissions (${dialect})`, () => {
    it('starts a new baseline after expiry, missed private gap and owner renewal', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'before')
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/a.md', 'before')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await f.t.db
          .updateTable('scope_grants')
          .set({ expires_at: '2030-01-01T00:01:00.000Z' })
          .where('id', '=', f.grant.id)
          .execute()
        f.setClock('2030-01-01T00:02:00.000Z')
        const away = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: first.file_id,
              base_version_id: first.version_id,
              to_path: 'Private/a.md',
            },
          ])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'private edit')
        const edit = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: away.version_id,
              sha: shaOf('private edit'),
              size: 12,
              mtime: 2,
            },
          ])
        ).results[0]
        const again = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: first.file_id,
              base_version_id: edit.version_id,
              to_path: 'Agents/a.md',
            },
          ])
        ).results[0]
        await updateFolderGrant(f.deps, f.owner.accountToken, f.vault, f.grant.id, {
          expected_revision: 0,
          expires_at: null,
        })
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const admitted = await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          first.file_id,
          again.version_id
        )
        expect(admitted.generation).toBe(2)
        for (const id of [first.version_id, away.version_id, edit.version_id])
          await expect(
            requireFolderVersion(f.deps, f.a.key_token, f.vault, f.grant.id, first.file_id, id)
          ).rejects.toMatchObject({ code: 'not_found' })
        const intervals = await f.t.db
          .selectFrom('scope_admission_intervals')
          .selectAll()
          .where('file_id', '=', first.file_id)
          .orderBy('generation')
          .execute()
        expect(intervals.map((row) => row.end_reason)).toEqual(['departed', null])
      } finally {
        await f.close()
      }
    })
    it('admits only the entry baseline and current interval, never pre-entry or private-gap history', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'private')
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Private/note.md', 'private'),
          ])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const entry = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: first.file_id,
              base_version_id: first.version_id,
              to_path: 'Agents/note.md',
            },
          ])
        ).results[0]
        const proof = await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          entry.file_id,
          entry.version_id
        )
        expect(proof.generation).toBe(1)
        await expect(
          requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            first.file_id,
            first.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
        await putBlob(f.t.app, f.device.deviceToken, 'shared edit')
        const edit = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: entry.file_id,
              base_version_id: entry.version_id,
              sha: shaOf('shared edit'),
              size: 11,
              mtime: 2,
            },
          ])
        ).results[0]
        expect(
          (
            await requireFolderVersion(
              f.deps,
              f.b.key_token,
              f.vault,
              f.grant.id,
              entry.file_id,
              entry.version_id
            )
          ).interval_id
        ).toBe(proof.interval_id)
        const gap = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: edit.file_id,
              base_version_id: edit.version_id,
              to_path: 'Private/gap.md',
            },
          ])
        ).results[0]
        await expect(
          requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            edit.file_id,
            edit.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
        const again = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: gap.file_id,
              base_version_id: gap.version_id,
              to_path: 'Agents/note.md',
            },
          ])
        ).results[0]
        expect(
          (
            await requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              again.file_id,
              again.version_id
            )
          ).generation
        ).toBe(2)
        for (const id of [first.version_id, entry.version_id, edit.version_id, gap.version_id])
          await expect(
            requireFolderVersion(f.deps, f.a.key_token, f.vault, f.grant.id, again.file_id, id)
          ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
    it('processes intermediate departures/re-entry within one commit instead of coalescing heads', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const response = await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: first.file_id,
            base_version_id: first.version_id,
            to_path: 'Private/note.md',
          },
          {
            op: 'move',
            file_id: first.file_id,
            // Personal move semantics accept an unavailable/pruned base; the first move
            // in this unit has a generated ID the client cannot name in advance.
            base_version_id: 'pruned-base',
            to_path: 'Agents/note.md',
          },
        ])
        expect(response.results.every((row: any) => row.status === 'applied')).toBe(true)
        const intervals = await f.t.db
          .selectFrom('scope_admission_intervals')
          .selectAll()
          .where('file_id', '=', first.file_id)
          .orderBy('generation')
          .execute()
        expect(intervals.map((row) => row.end_reason)).toEqual(['departed', null])
        expect(intervals.map((row) => row.generation)).toEqual([1, 2])
        await expect(
          requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            first.file_id,
            first.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
    it('distinguishes authorized deletion/trash from departure without leaking private destinations', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const deleted = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            { op: 'delete', file_id: first.file_id, base_version_id: first.version_id },
          ])
        ).results[0]
        const trash = await f.t.db.selectFrom('scope_trash').selectAll().execute()
        expect(trash[0]).toMatchObject({
          file_id: first.file_id,
          deleted_version_id: deleted.version_id,
          eligible: 1,
        })
        expect(
          (
            await requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              first.file_id,
              first.version_id
            )
          ).interval_id
        ).toBe(trash[0]!.interval_id)
        expect(await f.t.db.selectFrom('scope_current_members').selectAll().execute()).toEqual([])
      } finally {
        await f.close()
      }
    })
    it('keeps extra-era admitted history within a continuous folder interval after sponsor withdrawal', async () => {
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
        const admitted = await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          image.file_id,
          image.version_id
        )
        const moved = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: image.file_id,
              base_version_id: image.version_id,
              to_path: 'Agents/image.png',
            },
          ])
        ).results[0]
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: sponsor.file_id,
            base_version_id: sponsor.version_id,
            to_path: 'Private/sponsor.md',
          },
        ])
        expect(
          (
            await f.t.db
              .selectFrom('scope_extra_entries')
              .select('withdrawal_generation')
              .where('id', '=', 'extra')
              .executeTakeFirstOrThrow()
          ).withdrawal_generation
        ).toBe(1)
        expect(
          (
            await requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              image.file_id,
              image.version_id
            )
          ).interval_id
        ).toBe(admitted.interval_id)
        expect(
          (
            await requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              image.file_id,
              moved.version_id
            )
          ).interval_id
        ).toBe(admitted.interval_id)
      } finally {
        await f.close()
      }
    })
    it('withdraws a note sponsor that becomes an intrinsic attachment and never revives its extra', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const sponsor = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/sponsor.md', 'note'),
          ])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'image')
        const extra = (
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
            file_id: extra.file_id,
            origin: 'owner',
            first_version_id: extra.version_id,
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
        const renamed = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: sponsor.file_id,
              base_version_id: sponsor.version_id,
              to_path: 'Agents/sponsor.txt',
            },
          ])
        ).results[0]
        expect(
          (
            await f.t.db
              .selectFrom('scope_extra_entries')
              .select('withdrawal_generation')
              .where('id', '=', 'extra')
              .executeTakeFirstOrThrow()
          ).withdrawal_generation
        ).toBe(1)
        expect(await f.t.db.selectFrom('scope_extra_sponsors').selectAll().execute()).toEqual([])
        expect(
          (await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)).items.map(
            (item) => item.file_id
          )
        ).toEqual([sponsor.file_id])
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: sponsor.file_id,
            base_version_id: renamed.version_id,
            to_path: 'Agents/sponsor.md',
          },
        ])
        await expect(
          requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            extra.file_id,
            extra.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
    it('removes extra sponsorship on departure without reviving dormant permission on re-entry', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'sponsor')
        const note = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/note.md', 'sponsor'),
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
          .where('file_id', '=', note.file_id)
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
            note_id: note.file_id,
            interval_id: interval.id,
            admission_generation: interval.generation,
            intrinsic: 1,
            added_at: f.deps.now().toISOString(),
          })
          .execute()
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          image.file_id,
          image.version_id
        )
        const moved = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: note.file_id,
              base_version_id: note.version_id,
              to_path: 'Private/note.md',
            },
          ])
        ).results[0]
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
          (await f.t.db.selectFrom('scope_extra_entries').selectAll().execute())[0]
        ).toMatchObject({ withdrawal_generation: 1 })
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: note.file_id,
            base_version_id: moved.version_id,
            to_path: 'Agents/note.md',
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
        expect(await f.t.db.selectFrom('scope_extra_sponsors').selectAll().execute()).toEqual([])
      } finally {
        await f.close()
      }
    })
    it('holds only an unknown file and keeps folder preparation independent of group progress', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'known')
        const good = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/good.md', 'known')])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'legacy')
        const bad = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/legacy.md', 'legacy'),
          ])
        ).results[0]
        await f.t.db
          .deleteFrom('version_security_sources')
          .where('version_id', '=', bad.version_id)
          .execute()
        await f.t.db
          .deleteFrom('scope_current_members')
          .where('file_id', '=', bad.file_id)
          .execute()
        await f.t.db.schema.dropTable('scope_group_progress').execute()
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        expect(
          (
            await requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              good.file_id,
              good.version_id
            )
          ).generation
        ).toBeGreaterThan(0)
        await expect(
          requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            bad.file_id,
            bad.version_id
          )
        ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
  })
}
