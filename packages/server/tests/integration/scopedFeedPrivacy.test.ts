import { describe, expect, it } from 'vitest'
import { pollFolderFeed } from '../../src/scoped/feed.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped feed privacy (${dialect})`, () => {
    it('restarts a checkpoint after the configuration registry changes instead of disclosing old content', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'old')
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'old')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const base = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)
        await putBlob(f.t.app, f.device.deviceToken, 'new')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: head.file_id,
            base_version_id: head.version_id,
            sha: shaOf('new'),
            size: 3,
            mtime: 2,
          },
        ])
        await expect(
          pollFolderFeed(
            { ...f.deps, configurationDirectories: ['Agents'] },
            f.a.key_token,
            f.vault,
            f.grant.id,
            base.checkpoint
          )
        ).rejects.toMatchObject({ code: 'scope_unavailable' })
      } finally {
        await f.close()
      }
    })
    it('does not disclose an identity created and departed after the client empty snapshot', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const base = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)
        await putBlob(f.t.app, f.device.deviceToken, 'temporary')
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/unseen.md', 'temporary'),
          ])
        ).results[0]
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: head.file_id,
            base_version_id: head.version_id,
            to_path: 'Private/unseen.md',
          },
        ])
        const result = await pollFolderFeed(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          base.checkpoint
        )
        expect(result.events).toEqual([])
        expect(JSON.stringify(result)).not.toContain(head.file_id)
        const partial = await pollFolderFeed(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          base.checkpoint,
          1
        )
        expect(partial.events).toEqual([])
        await expect(
          pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, partial.checkpoint, 1)
        ).rejects.toMatchObject({ code: 'scope_unavailable' })
      } finally {
        await f.close()
      }
    })
  })
}
