import { describe, expect, it } from 'vitest'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `preparation original-head proof (${dialect})`,
    () => {
      it('holds after losing the actual start-watermark head instead of adopting an older in-folder version', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'same')
          const heads = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/a.md', 'same'),
              create('Agents/b.md', 'same'),
            ])
          ).results
          const ids = heads.map((head: any) => head.file_id).sort(),
            target = heads.find((head: any) => head.file_id === ids[1])
          const privateHead = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: target.file_id,
                base_version_id: target.version_id,
                to_path: 'Private/a.bin',
              },
            ])
          ).results[0]
          const first = await prepareFolderAdmissions(
            { ...f.deps, folderPreparationPageSize: 1 },
            f.owner.accountToken,
            f.vault,
            f.grant.id
          )
          expect(first.state).toBe('preparing')
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: target.file_id,
              base_version_id: privateHead.version_id,
              to_path: 'Agents/a.md',
            },
          ])
          // Represents retention pruning of attachment-class history between pages;
          // the older note-class version intentionally survives.
          await f.t.db.deleteFrom('versions').where('id', '=', privateHead.version_id).execute()
          await expect(
            prepareFolderAdmissions(
              { ...f.deps, folderPreparationPageSize: 1 },
              f.owner.accountToken,
              f.vault,
              f.grant.id
            )
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              target.file_id,
              target.version_id
            )
          ).rejects.toMatchObject({ code: 'scope_updating' })
        } finally {
          await f.close()
        }
      })
    }
  )
}
