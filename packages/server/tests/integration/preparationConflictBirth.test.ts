import { describe, expect, it, vi } from 'vitest'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import * as ids from '../../src/ids.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `preparation conflict-copy birth (${dialect})`,
    () => {
      for (const root of ['Agents', 'Private'])
        it(`recognises a real post-watermark conflict identity in ${root} without rebuilding`, async () => {
          const f = await scopedFixture(dialect)
          try {
            const titled = (s: string) => `---\ntitle: ${s}\n---\nbody\n`
            await putBlob(f.t.app, f.device.deviceToken, titled('a'))
            const head = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                create(`${root}/note.md`, titled('a')),
                create('Agents/other.md', titled('a')),
              ])
            ).results[0]
            const deps = { ...f.deps, folderPreparationPageSize: 1 }
            expect(
              (await prepareFolderAdmissions(deps, f.owner.accountToken, f.vault, f.grant.id)).state
            ).toBe('preparing')
            let serial = 0
            vi.spyOn(ids, 'newId').mockImplementation(() => `zz-post-watermark-${++serial}`)
            await putBlob(f.t.app, f.device.deviceToken, titled('b'))
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'modify',
                file_id: head.file_id,
                base_version_id: head.version_id,
                sha: shaOf(titled('b')),
                size: titled('b').length,
                mtime: 2,
              },
            ])
            await putBlob(f.t.app, f.device.deviceToken, titled('c'))
            const conflict = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                {
                  op: 'modify',
                  file_id: head.file_id,
                  base_version_id: head.version_id,
                  sha: shaOf(titled('c')),
                  size: titled('c').length,
                  mtime: 3,
                },
              ])
            ).results[0]
            expect(conflict.status).toBe('conflict')
            expect(conflict.conflict_file_id.startsWith('zz-')).toBe(true)
            let state = 'preparing'
            for (let i = 0; i < 10 && state !== 'active'; i++)
              state = (
                await prepareFolderAdmissions(deps, f.owner.accountToken, f.vault, f.grant.id)
              ).state
            expect(state).toBe('active')
            expect(
              (
                await f.t.db
                  .selectFrom('scope_current_members')
                  .select('file_id')
                  .where('file_id', '=', conflict.conflict_file_id)
                  .execute()
              ).length
            ).toBe(root === 'Agents' ? 1 : 0)
          } finally {
            vi.restoreAllMocks()
            await f.close()
          }
        })
    }
  )
