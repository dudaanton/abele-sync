import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`original content mtime (${dialect})`, () => {
    for (const partial of [false, true])
      for (const [headTime, incomingTime] of [
        [1000, 3],
        [3, 1000],
      ] as const)
        for (const exactIncoming of [false, true])
          it(`${partial ? 'folder' : 'root'} ${exactIncoming ? 'exact-incoming' : 'combined'} merge keeps max(${headTime}, ${incomingTime}), not server time`, async () => {
            const f = await tokenFixture(dialect)
            try {
              const first = success(await f.root.create('Agents/N.md', 'one\ntwo\nthree\n', 1))
              const headText = 'ONE\ntwo\nthree\n'
              const incoming = exactIncoming ? 'ONE\ntwo\nTHREE\n' : 'one\ntwo\nTHREE\n'
              const op = {
                op: 'modify' as const,
                file_id: first.file_id,
                base_version_id: first.version_id,
              }
              await f.root.commit([
                { ...op, ...(await f.root.upload(Buffer.from(headText))), mtime: headTime },
              ])
              const client = partial ? f.guest : f.root
              const blob = await client.upload(Buffer.from(incoming))
              const result = success(
                (await client.commit([{ ...op, ...blob, mtime: incomingTime }])).results[0]!
              )
              expect(result).toMatchObject({
                status: exactIncoming ? 'applied' : 'merged',
                mtime: 1000,
              })
              expect((await client.content(first.file_id)).toString()).toBe('ONE\ntwo\nTHREE\n')
              expect(
                await f.t.db
                  .selectFrom('versions')
                  .select('mtime')
                  .where('id', '=', result.version_id)
                  .executeTakeFirstOrThrow()
              ).toEqual({ mtime: 1000 })
              const inputs = await f.t.db
                .selectFrom('versions')
                .select(['blob_sha', 'mtime'])
                .where('file_id', '=', first.file_id)
                .execute()
              expect(inputs).toContainEqual({
                blob_sha: (await f.root.upload(Buffer.from(headText))).sha,
                mtime: headTime,
              })
              if (!exactIncoming)
                expect(inputs).toContainEqual({ blob_sha: blob.sha, mtime: incomingTime })
            } finally {
              await f.close()
            }
          })
    it('a conflict copy preserves the incoming bytes and original mtime', async () => {
      const f = await tokenFixture(dialect)
      try {
        const first = success(await f.root.create('Agents/N.md', 'base\n', 1))
        const op = {
          op: 'modify' as const,
          file_id: first.file_id,
          base_version_id: first.version_id,
        }
        await f.root.commit([
          { ...op, ...(await f.root.upload(Buffer.from('head\n'))), mtime: 1000 },
        ])
        const blob = await f.guest.upload(Buffer.from('incoming\n'))
        const result = success((await f.guest.commit([{ ...op, ...blob, mtime: 3 }])).results[0]!)
        expect(result).toMatchObject({ status: 'conflict', mtime: 1000 })
        if (result.status !== 'conflict') throw new Error('expected conflict')
        expect(
          await f.t.db
            .selectFrom('versions')
            .select(['mtime', 'blob_sha'])
            .where('id', '=', result.conflict_version_id!)
            .executeTakeFirstOrThrow()
        ).toEqual({ mtime: 3, blob_sha: blob.sha })
        expect((await f.guest.content(result.conflict_file_id!)).toString()).toBe('incoming\n')
      } finally {
        await f.close()
      }
    })
  })
