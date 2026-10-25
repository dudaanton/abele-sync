import { expect, it, describe } from 'vitest'
import { createHash } from 'node:crypto'
import { createUser } from '../../src/access/tokens.js'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { v2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

const HOUR = 3600000
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`continuation leases (${dialect})`, () => {
    async function fixture() {
      let clock = Date.parse('2025-01-01T00:00:00Z')
      const now = () => new Date(clock)
      const t = await v2Server(dialect, { now })
      const issued = await createUser(
        { db: t.db, pepper: t.config.tokenPepper, now },
        'Lease',
        t.address
      )
      const client = new V2SyncClient(issued.token)
      return {
        t,
        client,
        now,
        advance: (ms: number) => {
          clock += ms
        },
      }
    }
    it('renews active snapshots while abandoned snapshots expire, preserving frozen membership', async () => {
      const f = await fixture()
      try {
        for (const path of ['a.bin', 'b.bin', 'c.bin']) await f.client.create(path, path)
        const active = await f.client.manifest('?limit=1')
        await f.client.create('later.bin', 'later')
        const abandoned = await f.client.manifest('?limit=1')
        const next = (cursor: string) => f.client.manifest('?next=' + encodeURIComponent(cursor))
        f.advance(40 * 60000)
        const second = await next(active.next!)
        f.advance(40 * 60000)
        const third = await next(second.next!)
        expect(third.cursor).toBe(active.cursor)
        expect(
          [...active.items, ...second.items, ...third.items].some(
            (item) => item.path === 'later.bin'
          )
        ).toBe(false)
        await expect(next(abandoned.next!)).rejects.toMatchObject({
          status: 400,
          code: 'invalid_request',
        })
      } finally {
        await f.t.close()
      }
    })
    it('caps renewal even when a client keeps using the same valid continuation', async () => {
      const f = await fixture()
      try {
        await f.client.create('a.bin', 'a')
        await f.client.create('b.bin', 'b')
        const first = await f.client.manifest('?limit=1')
        const next = () => f.client.manifest('?next=' + encodeURIComponent(first.next!))
        for (let n = 1; n < (7 * 24 * 3) / 2; n++) {
          f.advance(40 * 60000)
          await next()
        }
        f.advance(40 * 60000)
        await expect(next()).rejects.toMatchObject({ status: 400, code: 'invalid_request' })
      } finally {
        await f.t.close()
      }
    }, 60000)
    it('retention keeps an actively used multipart session but sweeps an abandoned one', async () => {
      const f = await fixture()
      try {
        const bytes = Buffer.from([1, 2]),
          sha = createHash('sha256').update(bytes).digest('hex')
        const begin = await f.client.json(`/uploads/${sha}/begin`, 'POST', {
          size: 2,
          max_part_bytes: 1,
        })
        const other = createHash('sha256')
          .update(Buffer.from([3, 4]))
          .digest('hex')
        await f.client.json(`/uploads/${other}/begin`, 'POST', { size: 2, max_part_bytes: 1 })
        const base = `/uploads/${sha}/${begin.upload_id}`
        f.advance(23 * HOUR)
        expect((await f.client.request(base + '/0', 'PUT', bytes.subarray(0, 1))).status).toBe(204)
        f.advance(2 * HOUR)
        const sweeper = createUploadManager({ ...f.t, now: f.now })
        expect(await sweeper.sweep(new Date(f.now().getTime() - 24 * HOUR))).toBe(1)
        expect((await f.client.request(base + '/1', 'PUT', bytes.subarray(1))).status).toBe(204)
        expect((await f.client.request(base + '/complete', 'POST')).status).toBe(201)
      } finally {
        await f.t.close()
      }
    })
  })
