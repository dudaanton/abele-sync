import { describe, expect, it, vi } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { stat } from 'node:fs/promises'
import { generationPath } from '../../src/restoreGeneration.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(dialect, () => {
    // BUG: stable paging still copies the whole scope on its first page. Bounding this
    // requires a versioned membership/snapshot design, not truncating a complete snapshot.
    it.fails('bounds initial manifest materialization by the requested page size', async () => {
      const f = await tokenFixture(dialect)
      try {
        await f.root.create('Agents/a.md', 'a')
        await f.root.create('Agents/b.md', 'b')
        expect((await f.guest.manifest('?limit=1')).items).toHaveLength(1)
        const snapshots = await f.t.db.selectFrom('scope_snapshots').select('id').execute()
        expect(
          await f.t.db
            .selectFrom('scope_snapshot_items')
            .select('file_id')
            .where(
              'snapshot_id',
              'in',
              snapshots.map((s) => s.id)
            )
            .execute()
        ).toHaveLength(1)
      } finally {
        await f.close()
      }
    })

    it('coalesces download counter writes while keeping exact transfer totals', async () => {
      // Hold the periodic flush: correctness must depend on draining the server,
      // not on how quickly a runner schedules the 250 ms timer.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      let f: Awaited<ReturnType<typeof tokenFixture>> | undefined
      try {
        f = await tokenFixture(dialect)
        const file = success(await f.root.create('Agents/a.md', 'hello'))
        const writes = vi.spyOn(f.t.db, 'insertInto')
        try {
          for (let i = 0; i < 20; i++) await f.guest.content(file.file_id)
          // Only the first sample has been submitted; the remaining transfers
          // must be persisted by onClose, even if the timer never runs.
          expect(writes.mock.calls.filter(([table]) => table === 'activity_daily').length).toBe(1)
          await f.t.stop()
          expect(
            await f.t.db
              .selectFrom('activity_daily')
              .selectAll()
              .where('token_id', '=', f.share.info.id)
              .executeTakeFirst()
          ).toMatchObject({ downloaded_files: 20, downloaded_bytes: 100 })
          expect(
            writes.mock.calls.filter(([table]) => table === 'activity_daily').length
          ).toBeLessThan(20)
        } finally {
          writes.mockRestore()
        }
      } finally {
        try {
          await f?.close()
        } finally {
          vi.useRealTimers()
        }
      }
    })

    it('reuses an unchanged manifest snapshot rather than copying it for every request', async () => {
      const f = await tokenFixture(dialect)
      try {
        await f.root.create('Agents/a.md', 'hello')
        for (let i = 0; i < 10; i++) await f.guest.manifest('?limit=1')
        expect(
          await f.t.db
            .selectFrom('scope_snapshots')
            .select('id')
            .where(
              'scope_id',
              '=',
              (
                await f.t.db
                  .selectFrom('access_tokens')
                  .select('scope_id')
                  .where('id', '=', f.share.info.id)
                  .executeTakeFirstOrThrow()
              ).scope_id
            )
            .execute()
        ).toHaveLength(1)
      } finally {
        await f.close()
      }
    })

    it('does not checkpoint rejected or unknown unauthenticated mutation requests', async () => {
      const f = await tokenFixture(dialect)
      try {
        const checkpoint = generationPath(f.t.config.blobDir)
        const before = await stat(checkpoint, { bigint: true })
        for (const path of ['/v2/commit', '/unknown', '/v2/connection/delete']) {
          const response = await fetch(f.t.address + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          expect(response.status).toBeGreaterThanOrEqual(400)
          await response.arrayBuffer()
        }
        expect((await stat(checkpoint, { bigint: true })).mtimeNs).toBe(before.mtimeNs)
      } finally {
        await f.close()
      }
    })
  })
