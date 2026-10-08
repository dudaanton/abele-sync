import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`missing modify base (${dialect})`, () => {
    for (const missing of ['pruned', 'unknown', 'contentless'] as const) {
      it(`keeps the live note and copies incoming bytes when the base is ${missing}`, async () => {
        const t = await buildTestApp({ dialect })
        try {
          const { accountToken } = await t.account()
          const { vaultId } = await t.vault(accountToken)
          const { deviceToken } = await t.device(accountToken, vaultId)
          const send = async (ops: unknown[]) =>
            (await commit(t.app, deviceToken, vaultId, ops)).results[0]
          const base = 'removed text\nbase note\n',
            current = 'current note\n',
            incoming = 'removed text\nstale note\n'
          await putBlob(t.app, deviceToken, base)
          const first = await send([create('note.md', base)])
          let baseId = first.version_id
          if (missing === 'contentless') {
            const deleted = await send([
              { op: 'delete', file_id: first.file_id, base_version_id: baseId },
            ])
            baseId = deleted.version_id
          }
          await putBlob(t.app, deviceToken, current)
          const latest = await send([
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: baseId,
              sha: shaOf(current),
              size: Buffer.byteLength(current),
              mtime: 2,
            },
          ])
          if (missing === 'pruned')
            await t.db.deleteFrom('versions').where('id', '=', baseId).execute()
          if (missing === 'unknown') baseId = 'never-in-this-vault'
          const before = await t.db.selectFrom('versions').select('id').execute()
          await putBlob(t.app, deviceToken, incoming)
          const result = await send([
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: baseId,
              sha: shaOf(incoming),
              size: Buffer.byteLength(incoming),
              mtime: 3,
            },
          ])
          expect(result).toMatchObject({
            status: 'conflict',
            version_id: latest.version_id,
            sha: shaOf(current),
          })
          expect(
            await t.db
              .selectFrom('files')
              .select('head_version_id')
              .where('id', '=', first.file_id)
              .executeTakeFirstOrThrow()
          ).toEqual({ head_version_id: latest.version_id })
          expect((await t.store.get(result.sha)).toString()).toBe(current)
          const copy = await t.db
            .selectFrom('versions')
            .selectAll()
            .where('id', '=', result.conflict_version_id)
            .executeTakeFirstOrThrow()
          expect(copy).toMatchObject({
            file_id: result.conflict_file_id,
            path: result.conflict_path,
            op: 'conflict',
            blob_sha: shaOf(incoming),
          })
          expect((await t.store.get(copy.blob_sha!)).toString()).toBe(incoming)
          expect(await t.db.selectFrom('versions').select('id').execute()).toHaveLength(
            before.length + 1
          )
          expect(
            await t.db.selectFrom('versions').select('id').where('op', '=', 'merge').execute()
          ).toHaveLength(0)
        } finally {
          await t.close()
        }
      })
    }
    for (const path of ['image.png', '.obsidian/app.json']) {
      for (const mtime of [1, 3]) {
        it(`preserves newer-mtime resolution for ${path} with unknown base and incoming mtime ${mtime}`, async () => {
          const t = await buildTestApp({ dialect })
          try {
            const { accountToken } = await t.account()
            const { vaultId } = await t.vault(accountToken)
            const { deviceToken } = await t.device(accountToken, vaultId)
            await putBlob(t.app, deviceToken, 'head')
            const first = (await commit(t.app, deviceToken, vaultId, [create(path, 'head', 2)]))
              .results[0]
            await putBlob(t.app, deviceToken, 'incoming')
            const result = (
              await commit(t.app, deviceToken, vaultId, [
                {
                  op: 'modify',
                  file_id: first.file_id,
                  base_version_id: 'pruned-base',
                  sha: shaOf('incoming'),
                  size: 8,
                  mtime,
                },
              ])
            ).results[0]
            expect(result).toMatchObject({
              status: mtime > 2 ? 'applied' : 'merged',
              sha: shaOf(mtime > 2 ? 'incoming' : 'head'),
            })
            expect(result).not.toHaveProperty('conflict_file_id')
            expect(
              (await t.db.selectFrom('versions').select('blob_sha').execute()).map(
                (v) => v.blob_sha
              )
            ).toContain(shaOf('incoming'))
          } finally {
            await t.close()
          }
        })
      }
    }
  })
}
