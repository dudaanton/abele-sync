import { describe, expect, it } from 'vitest'
import { prepareScopedModify } from '../../src/scoped/mergeInputs.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { mergeText } from '../../src/merge/index.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `authorized scoped merge inputs (${dialect})`,
    () => {
      it('uses the same pure personal merge for a stale admitted base, with no scoped conflict-only policy', async () => {
        const f = await scopedFixture(dialect)
        try {
          const base = 'one\ntwo\nthree\n',
            owner = 'ONE\ntwo\nthree\n',
            recipient = 'one\ntwo\nTHREE\n'
          await putBlob(f.t.app, f.device.deviceToken, base)
          const first = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/shared.md', base)])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await putBlob(f.t.app, f.device.deviceToken, owner)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: first.version_id,
              sha: shaOf(owner),
              size: Buffer.byteLength(owner),
              mtime: 2,
            },
          ])
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf(recipient),
            Buffer.from(recipient)
          )
          const result = await prepareScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, {
            file_id: first.file_id,
            base_version_id: first.version_id,
            sha: shaOf(recipient),
            size: Buffer.byteLength(recipient),
            mtime: 3,
          })
          expect(result.decision).toBe('merge')
          expect(result.text).toBe(mergeText(base, owner, recipient).text)
          expect(result.text).toContain('ONE')
          expect(result.text).toContain('THREE')
          expect(
            await f.t.db
              .selectFrom('versions')
              .selectAll()
              .where('file_id', '=', first.file_id)
              .execute()
          ).toHaveLength(2)
        } finally {
          await f.close()
        }
      })
      it('allows reuse of currently admitted content without vault-wide SHA lookup or a new upload', async () => {
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
          const result = await prepareScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, {
            file_id: first.file_id,
            base_version_id: first.version_id,
            sha: shaOf('one'),
            size: 3,
            mtime: 3,
          })
          expect(result.decision).not.toBe('reject')
        } finally {
          await f.close()
        }
      })
      it('prepares a conflict copy for a proven admitted base whose payload was pruned', async () => {
        const f = await scopedFixture(dialect)
        try {
          const base = 'a\nb\nc\n',
            current = 'A\nb\nc\n',
            incoming = 'a\nb\nC\n'
          await putBlob(f.t.app, f.device.deviceToken, base)
          const first = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', base)])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await putBlob(f.t.app, f.device.deviceToken, current)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: first.version_id,
              sha: shaOf(current),
              size: current.length,
              mtime: 2,
            },
          ])
          await f.t.db.deleteFrom('versions').where('id', '=', first.version_id).execute()
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf(incoming),
            Buffer.from(incoming)
          )
          const result = await prepareScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, {
            file_id: first.file_id,
            base_version_id: first.version_id,
            sha: shaOf(incoming),
            size: incoming.length,
            mtime: 3,
          })
          expect(result.decision).toBe('conflict-file')
          expect(result).not.toHaveProperty('text')
        } finally {
          await f.close()
        }
      })
      it('denies private/old-interval bases and guessed SHA generically before reading incoming bytes', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'private')
          const hidden = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Private/hidden.md', 'private'),
            ])
          ).results[0]
          await putBlob(f.t.app, f.device.deviceToken, 'shared')
          const visible = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/shared.md', 'shared'),
            ])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          const ask = (file_id: string, base_version_id: string) =>
            prepareScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, {
              file_id,
              base_version_id,
              sha: shaOf('private'),
              size: 7,
              mtime: 2,
            }).catch((error) => error.toBody())
          expect(await ask(visible.file_id, hidden.version_id)).toEqual(
            await ask(visible.file_id, 'unknown-base')
          )
          expect((await ask(hidden.file_id, hidden.version_id)).error.code).toBe('not_found')
          await expect(
            prepareScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, {
              file_id: visible.file_id,
              base_version_id: visible.version_id,
              sha: shaOf('private'),
              size: 7,
              mtime: 2,
            })
          ).rejects.toMatchObject({ code: 'not_found', details: {} })
        } finally {
          await f.close()
        }
      })
    }
  )
}
