import { describe, expect, it } from 'vitest'
import { pollFolderFeed } from '../../src/scoped/feed.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`grant-local feed (${dialect})`, () => {
    it('does not advance or expose private activity, and returns only admitted content without global seq/actors', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const base = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1000)
        await putBlob(f.t.app, f.device.deviceToken, 'private')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          create('Private/secret.md', 'private'),
        ])
        const quiet = await pollFolderFeed(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          base.checkpoint
        )
        expect(quiet.events).toEqual([])
        expect(quiet.checkpoint).toEqual(base.checkpoint)
        await putBlob(f.t.app, f.device.deviceToken, 'visible')
        const visible = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/note.md', 'visible'),
          ])
        ).results[0]
        const feed = await pollFolderFeed(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          quiet.checkpoint
        )
        expect(feed.events).toEqual([
          {
            type: 'content',
            file: {
              file_id: visible.file_id,
              version_id: visible.version_id,
              path: 'Agents/note.md',
              kind: 'note',
              sha: shaOf('visible'),
              size: 7,
              mtime: 1,
            },
          },
        ])
        expect(JSON.stringify(feed)).not.toMatch(
          /secret|head_seq|prev_path|actor_id|"seq"|"position"/
        )
      } finally {
        await f.close()
      }
    })
    it('reports safe departure and real deletion, suppressing content from now-inaccessible intervals', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const heads = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/out.md', 'note'),
            create('Agents/deleted.md', 'note'),
          ])
        ).results
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const base = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1000)
        await putBlob(f.t.app, f.device.deviceToken, 'edit')
        const edited = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: heads[0].file_id,
              base_version_id: heads[0].version_id,
              sha: shaOf('edit'),
              size: 4,
              mtime: 2,
            },
          ])
        ).results[0]
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: heads[0].file_id,
            base_version_id: edited.version_id,
            to_path: 'Private/new-secret.md',
          },
          { op: 'delete', file_id: heads[1].file_id, base_version_id: heads[1].version_id },
        ])
        const feed = await pollFolderFeed(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          base.checkpoint
        )
        expect(feed.events).toEqual([
          { type: 'departed', file_id: heads[0].file_id },
          { type: 'deleted', file_id: heads[1].file_id },
        ])
        expect(JSON.stringify(feed)).not.toMatch(/new-secret|Private|"path"|"sha"/)
      } finally {
        await f.close()
      }
    })
    it('emits a dependent extra departure when its last intrinsic sponsor leaves', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const note = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
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
        const snapshot = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1000)
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: note.file_id,
            base_version_id: note.version_id,
            to_path: 'Private/note.md',
          },
        ])
        const feed = await pollFolderFeed(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          snapshot.checkpoint
        )
        expect(feed.events).toEqual([
          { type: 'departed', file_id: image.file_id },
          { type: 'departed', file_id: note.file_id },
        ])
      } finally {
        await f.close()
      }
    })
    it('requires resnapshot for pruned/gapped/wrong-principal/issuer progress, never a numeric fallback', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const base = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1000)
        for (const [token, deps, checkpoint] of [
          [f.b.key_token, f.deps, base.checkpoint],
          [
            f.a.key_token,
            { ...f.deps, endpointIdentity: 'https://other.invalid' },
            base.checkpoint,
          ],
          [f.a.key_token, f.deps, { kind: 'scoped', token: '1' }],
        ] as const) {
          await expect(
            pollFolderFeed(deps, token, f.vault, f.grant.id, checkpoint)
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
        }
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
        await f.t.db
          .updateTable('scope_feed_state')
          .set({ minimum_position: 1 })
          .where('grant_id', '=', f.grant.id)
          .execute()
        await expect(
          pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, base.checkpoint)
        ).rejects.toMatchObject({ code: 'scope_unavailable' })
      } finally {
        await f.close()
      }
    })
    it('bounds pages, preserves idempotent polling and refuses revoked credentials', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const base = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1000)
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          create('Agents/a.md', 'note'),
          create('Agents/b.md', 'note'),
        ])
        const first = await pollFolderFeed(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          base.checkpoint,
          1
        )
        expect(first.events).toHaveLength(1)
        expect(first.has_more).toBe(true)
        const last = await pollFolderFeed(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          first.checkpoint,
          1
        )
        expect(last.events).toHaveLength(1)
        expect(last.has_more).toBe(false)
        await expect(
          pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, last.checkpoint, 1001)
        ).rejects.toMatchObject({ code: 'invalid_request' })
        await f.revoke(f.a.key_id)
        await expect(
          pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, last.checkpoint)
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        await f.close()
      }
    })
  })
}
