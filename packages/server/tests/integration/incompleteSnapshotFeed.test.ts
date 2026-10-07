import { describe, expect, it } from 'vitest'
import { openFolderSnapshot, readFolderSnapshotPage } from '../../src/scoped/snapshots.js'
import { pollFolderFeed } from '../../src/scoped/feed.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `snapshot completion feed proof (${dialect})`,
    () => {
      it('never treats a first page checkpoint as proof of identities on an invalidated unread page', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'same')
          const heads = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/a.md', 'same'),
              create('Agents/b.md', 'same'),
            ])
          ).results
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          const first = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          expect(first.items.map((item) => item.file_id)).toEqual([heads[0].file_id])
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: heads[1].file_id,
              base_version_id: heads[1].version_id,
              to_path: 'Private/b.md',
            },
          ])
          await expect(
            pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, first.checkpoint)
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
          await expect(
            readFolderSnapshotPage(f.deps, f.a.key_token, f.vault, f.grant.id, first.next_cursor!)
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
        } finally {
          await f.close()
        }
      })
      it('requires the separately delivered terminal proof even after the server marked paging complete', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'same')
          const heads = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/a.md', 'same'),
              create('Agents/b.md', 'same'),
            ])
          ).results
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          const first = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          const last = await readFolderSnapshotPage(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            first.next_cursor!
          )
          expect(last.checkpoint).toEqual(first.checkpoint)
          expect(last.feed_checkpoint).toBeDefined()
          await expect(
            pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, first.checkpoint)
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: heads[1].file_id,
              base_version_id: heads[1].version_id,
              to_path: 'Private/b.md',
            },
          ])
          expect(
            (
              await pollFolderFeed(
                f.deps,
                f.a.key_token,
                f.vault,
                f.grant.id,
                last.feed_checkpoint!
              )
            ).events
          ).toEqual([{ type: 'departed', file_id: heads[1].file_id }])
        } finally {
          await f.close()
        }
      })
    }
  )
