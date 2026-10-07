import { describe, expect, it } from 'vitest'
import {
  listFolderHistory,
  listFolderTrash,
  readFolderHistoricalVersion,
} from '../../src/scoped/history.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped history and trash (${dialect})`, () => {
    it('admits only current-interval versions and their bytes, excluding pre-entry and private-gap IDs', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'private')
        const initial = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Private/note.md', 'private'),
          ])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const entry = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: initial.file_id,
              base_version_id: initial.version_id,
              to_path: 'Agents/note.md',
            },
          ])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'shared')
        const edited = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: entry.file_id,
              base_version_id: entry.version_id,
              sha: shaOf('shared'),
              size: 6,
              mtime: 2,
            },
          ])
        ).results[0]
        const history = await listFolderHistory(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          entry.file_id
        )
        expect(history.items.map((row) => row.version_id)).toEqual([
          edited.version_id,
          entry.version_id,
        ])
        expect(JSON.stringify(history)).not.toMatch(/private|merge|actor|prev_path|head_seq/)
        await expect(
          readFolderHistoricalVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            entry.file_id,
            initial.version_id,
            { method: 'GET' }
          )
        ).rejects.toMatchObject({ code: 'not_found', details: {} })
        const bytes = await readFolderHistoricalVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          entry.file_id,
          entry.version_id,
          { method: 'GET' }
        )
        expect(bytes.body?.toString()).toBe('private')
        expect(bytes.headers['cache-control']).toBe('no-store')
        const away = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: edited.file_id,
              base_version_id: edited.version_id,
              to_path: 'Private/note.md',
            },
          ])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'gap')
        const gap = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: away.file_id,
              base_version_id: away.version_id,
              sha: shaOf('gap'),
              size: 3,
              mtime: 3,
            },
          ])
        ).results[0]
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
            await listFolderHistory(f.deps, f.a.key_token, f.vault, f.grant.id, entry.file_id)
          ).items.map((row) => row.version_id)
        ).toEqual([again.version_id])
        await expect(
          readFolderHistoricalVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            entry.file_id,
            edited.version_id,
            { method: 'HEAD', ifNoneMatch: `"${shaOf('shared')}"` }
          )
        ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
    it('binds history page cursors to the principal and refuses forged/wrong-grant progress', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'one')
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'one')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await putBlob(f.t.app, f.device.deviceToken, 'two')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: first.file_id,
            base_version_id: first.version_id,
            sha: shaOf('two'),
            size: 3,
            mtime: 2,
          },
        ])
        const firstPage = await listFolderHistory(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          first.file_id,
          1
        )
        expect(firstPage.items).toHaveLength(1)
        expect(firstPage.next_cursor).toBeTruthy()
        expect(
          (
            await listFolderHistory(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              first.file_id,
              1,
              firstPage.next_cursor!
            )
          ).items.map((row) => row.version_id)
        ).toEqual([first.version_id])
        for (const [token, deps, cursor] of [
          [f.b.key_token, f.deps, firstPage.next_cursor!],
          [
            f.a.key_token,
            { ...f.deps, endpointIdentity: 'https://another.invalid' },
            firstPage.next_cursor!,
          ],
          [f.a.key_token, f.deps, firstPage.next_cursor! + 'x'],
        ] as const)
          await expect(
            listFolderHistory(deps, token, f.vault, f.grant.id, first.file_id, 1, cursor)
          ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
    it('distinguishes real scoped trash from departure; absent deletion evidence cannot masquerade as a delete', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const heads = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/trash.md', 'note'),
            create('Agents/leave.md', 'note'),
          ])
        ).results
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          { op: 'delete', file_id: heads[0].file_id, base_version_id: heads[0].version_id },
          {
            op: 'move',
            file_id: heads[1].file_id,
            base_version_id: heads[1].version_id,
            to_path: 'Private/hidden.md',
          },
        ])
        expect(
          (await listFolderTrash(f.deps, f.a.key_token, f.vault, f.grant.id)).items.map(
            (row) => row.file_id
          )
        ).toEqual([heads[0].file_id])
        const bytes = await readFolderHistoricalVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          heads[0].file_id,
          heads[0].version_id,
          { method: 'GET', range: 'bytes=1-2' }
        )
        expect(bytes.body?.toString()).toBe('ot')
        await f.t.db
          .updateTable('scope_trash')
          .set({ eligible: 0 })
          .where('file_id', '=', heads[0].file_id)
          .execute()
        await expect(
          readFolderHistoricalVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            heads[0].file_id,
            heads[0].version_id,
            { method: 'GET' }
          )
        ).rejects.toMatchObject({ code: 'not_found' })
        expect((await listFolderTrash(f.deps, f.a.key_token, f.vault, f.grant.id)).items).toEqual(
          []
        )
      } finally {
        await f.close()
      }
    })
  })
}
