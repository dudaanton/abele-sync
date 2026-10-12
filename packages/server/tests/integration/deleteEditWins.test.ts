import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`delete versus edit (${dialect})`, () => {
    for (const partial of [false, true])
      for (const ext of ['md', 'canvas', 'png'])
        for (const pruned of [false, true])
          it(`${partial ? 'folder' : 'root'} ${ext}: stale edit revives the same identity${pruned ? ' after base payload GC' : ''}`, async () => {
            const f = await tokenFixture(dialect)
            try {
              const first = success(await f.root.create(`Agents/N.${ext}`, 'base\n', 100))
              const removed = success(
                (
                  await f.root.commit([
                    { op: 'delete', file_id: first.file_id, base_version_id: first.version_id },
                  ])
                ).results[0]!
              )
              if (pruned)
                await f.t.db.deleteFrom('versions').where('id', '=', first.version_id).execute()
              const client = partial ? f.guest : f.root
              await expect(client.content(first.file_id)).rejects.toMatchObject({ status: 404 })
              // The tombstone is not live content. Explicit visible history remains
              // downloadable for trash review/restore, unless its payload was pruned.
              if (pruned)
                await expect(client.content(first.file_id, first.version_id)).rejects.toMatchObject(
                  { status: 404 }
                )
              else
                expect((await client.content(first.file_id, first.version_id)).toString()).toBe(
                  'base\n'
                )
              const blob = await client.upload(Buffer.from('offline edit\n'))
              const result = success(
                (
                  await client.commit([
                    {
                      op: 'modify',
                      file_id: first.file_id,
                      base_version_id: first.version_id,
                      ...blob,
                      mtime: 50,
                    },
                  ])
                ).results[0]!
              )
              expect(result).toMatchObject({
                status: 'applied',
                file_id: first.file_id,
                path: first.path,
                sha: blob.sha,
                mtime: 50,
              })
              expect(result.version_id).not.toBe(removed.version_id)
              expect((await client.content(first.file_id)).toString()).toBe('offline edit\n')
              expect(
                await f.t.db
                  .selectFrom('versions')
                  .select('id')
                  .where('op', '=', 'conflict')
                  .execute()
              ).toEqual([])
              expect(
                await f.t.db
                  .selectFrom('files')
                  .select('deleted_at')
                  .where('id', '=', first.file_id)
                  .executeTakeFirstOrThrow()
              ).toEqual({ deleted_at: null })
            } finally {
              await f.close()
            }
          })
    for (const invalid of ['unknown base', 'private base', 'departure', 'revocation'] as const)
      it(`folder revival refuses ${invalid} without consuming uploads or changing the tombstone`, async () => {
        const f = await tokenFixture(dialect)
        try {
          const first = success(await f.root.create('Agents/N.md', 'base\n'))
          let base = first.version_id
          if (invalid === 'private base')
            base = success(await f.root.create('Private.md', 'private')).version_id
          if (invalid === 'unknown base') base = 'unknown'
          let current = first
          if (invalid === 'departure')
            current = success(
              (
                await f.root.commit([
                  {
                    op: 'move',
                    file_id: first.file_id,
                    base_version_id: base,
                    to_path: 'Private/N.md',
                  },
                ])
              ).results[0]!
            )
          const removed = success(
            (
              await f.root.commit([
                { op: 'delete', file_id: first.file_id, base_version_id: current.version_id },
              ])
            ).results[0]!
          )
          const blob = await f.guest.upload(Buffer.from('offline edit\n'))
          if (invalid === 'revocation') await f.root.json('/tokens/' + f.share.info.id, 'DELETE')
          const before = await f.t.db.selectFrom('versions').select('id').execute()
          const uploads = await f.t.db
            .selectFrom('blob_uploads')
            .selectAll()
            .where('sha', '=', blob.sha)
            .execute()
          const request = f.guest.commit([
            { op: 'modify', file_id: first.file_id, base_version_id: base, ...blob, mtime: 50 },
          ])
          if (invalid === 'revocation') await expect(request).rejects.toMatchObject({ status: 401 })
          else
            expect((await request).results[0]).toMatchObject({
              status: 'rejected',
              code: 'not_found',
            })
          expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual(before)
          expect(
            await f.t.db
              .selectFrom('files')
              .select('head_version_id')
              .where('id', '=', first.file_id)
              .executeTakeFirstOrThrow()
          ).toEqual({ head_version_id: removed.version_id })
          expect(
            await f.t.db
              .selectFrom('blob_uploads')
              .selectAll()
              .where('sha', '=', blob.sha)
              .execute()
          ).toEqual(uploads)
        } finally {
          await f.close()
        }
      })
    for (const partial of [false, true])
      it(`${partial ? 'folder' : 'root'}: divergence dedup does not defeat an edit after original deletion`, async () => {
        const f = await tokenFixture(dialect)
        try {
          const first = success(await f.root.create('Agents/N.md', 'base\n'))
          const op = {
            op: 'modify' as const,
            file_id: first.file_id,
            base_version_id: first.version_id,
          }
          const head = success(
            (
              await f.root.commit([
                { ...op, ...(await f.root.upload(Buffer.from('head\n'))), mtime: 100 },
              ])
            ).results[0]!
          )
          const blob = await f.root.upload(Buffer.from('incoming\n'))
          const copy = success((await f.root.commit([{ ...op, ...blob, mtime: 50 }])).results[0]!)
          expect(copy.status).toBe('conflict')
          if (copy.status !== 'conflict') throw new Error('expected conflict')
          await f.root.commit([
            { op: 'delete', file_id: first.file_id, base_version_id: head.version_id },
          ])
          const client = partial ? f.guest : f.root
          const result = success(
            (
              await client.commit([
                { ...op, ...(await client.upload(Buffer.from('incoming\n'))), mtime: 50 },
              ])
            ).results[0]!
          )
          expect(result).toMatchObject({
            status: 'applied',
            file_id: first.file_id,
            sha: blob.sha,
            mtime: 50,
          })
          expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(2)
          expect(
            await f.t.db.selectFrom('conflict_divergences').selectAll().execute()
          ).toHaveLength(1)
          expect(
            await f.t.db
              .selectFrom('files')
              .select('head_version_id')
              .where('id', '=', copy.conflict_file_id!)
              .executeTakeFirstOrThrow()
          ).toEqual({ head_version_id: copy.conflict_version_id })
        } finally {
          await f.close()
        }
      })
    for (const long of [false, true])
      it(`folder: occupied ${long ? 'near-limit' : 'ordinary'} path revives within the authorized parent`, async () => {
        const f = await tokenFixture(dialect)
        try {
          const folder = long
            ? 'Agents/' + Array(4).fill('x'.repeat(250)).join('/') + '/'
            : 'Agents/'
          const first = success(await f.root.create(folder + 'N.md', 'base\n'))
          await f.root.commit([
            { op: 'delete', file_id: first.file_id, base_version_id: first.version_id },
          ])
          const occupying = success(await f.root.create(first.path, 'occupying'))
          const result = success(
            (
              await f.guest.commit([
                {
                  op: 'modify',
                  file_id: first.file_id,
                  base_version_id: first.version_id,
                  ...(await f.guest.upload(Buffer.from('offline\n'))),
                  mtime: 50,
                },
              ])
            ).results[0]!
          )
          expect(result).toMatchObject({ status: 'applied', file_id: first.file_id, mtime: 50 })
          expect(result.path).not.toBe(first.path)
          expect(result.path.startsWith(folder)).toBe(true)
          expect(Buffer.byteLength(result.path)).toBeLessThanOrEqual(1024)
          expect((await f.root.content(occupying.file_id)).toString()).toBe('occupying')
        } finally {
          await f.close()
        }
      })
  })
