import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
import { pollFolderFeed } from '../../src/scoped/feed.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `restored interval presentation (${dialect})`,
    () => {
      it('does not introduce a trash-only identity via departure after restore and private move', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'note')
          const first = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            { op: 'delete', file_id: first.file_id, base_version_id: first.version_id },
          ])
          const snapshot = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)
          expect(snapshot.items).toEqual([])
          const restored = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              { op: 'restore', file_id: first.file_id, version_id: first.version_id },
            ])
          ).results[0]
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: first.file_id,
              base_version_id: restored.version_id,
              to_path: 'Private/note.md',
            },
          ])
          const result = await pollFolderFeed(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            snapshot.checkpoint
          )
          expect(result.events).toEqual([])
          expect(JSON.stringify(result)).not.toContain(first.file_id)
        } finally {
          await f.close()
        }
      })
    }
  )
