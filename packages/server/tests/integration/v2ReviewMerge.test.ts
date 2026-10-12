import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`review merge data safety (${dialect})`, () => {
    for (const reverse of [false, true])
      it(`review 3: insertion/replacement alignment never drops an edit (${reverse ? 'reverse' : 'forward'} order)`, async () => {
        const f = await tokenFixture(dialect)
        try {
          const base = success(await f.root.create('Agents/N.md', 'a\nb\n'))
          const variants = reverse ? ['X\nb\n', 'X\na\nY\n'] : ['X\na\nY\n', 'X\nb\n']
          const op = {
            op: 'modify' as const,
            file_id: base.file_id,
            base_version_id: base.version_id,
          }
          success(
            (
              await f.root.commit([
                { ...op, ...(await f.root.upload(Buffer.from(variants[0]!))), mtime: 2000 },
              ])
            ).results[0]!
          )
          const incoming = {
            ...op,
            ...(await f.guest.upload(Buffer.from(variants[1]!))),
            mtime: 3000,
          }
          const result = success((await f.guest.commit([incoming], 'review-merge')).results[0]!)
          expect(result.status).toBe('conflict')
          if (result.status !== 'conflict')
            throw new Error('uncertain alignment must produce a conflict copy')
          expect((await f.guest.content(base.file_id)).toString()).toBe(variants[0])
          expect((await f.guest.content(result.conflict_file_id!)).toString()).toBe(variants[1])
          expect(await f.guest.commit([incoming], 'review-merge')).toMatchObject({
            results: [result],
          })
          expect(
            success((await f.guest.commit([incoming], 'review-merge-again')).results[0]!).status
          ).toBe('conflict')
          expect(
            (await f.guest.manifest()).items.filter((i) => i.kind !== 'directory')
          ).toHaveLength(2)
          expect(
            await f.t.db.selectFrom('versions').selectAll().where('op', '=', 'merge').execute()
          ).toEqual([])
        } finally {
          await f.close()
        }
      })
  })
