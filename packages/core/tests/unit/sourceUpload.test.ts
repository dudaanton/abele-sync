import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import { V2EngineClient } from '../../src/v2Client.js'
import { sha256 } from '../../src/hash.js'
import type { ChunkSource } from '../../src/streaming.js'

it('uploads a source in two bounded passes and closes it', async () => {
  const bytes = new Uint8Array(1024 * 1024 + 7).fill(3)
  const reads: number[] = []
  let closed = false
  const requests: string[] = []
  const client = new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'https://test',
      key: 'k'.repeat(43),
      scope: { kind: 'folder', id: 'f', path: '/' },
    }),
    {
      fetch: async (url, init) => {
        requests.push(String(url))
        if (init?.body instanceof Uint8Array)
          expect(init.body.byteLength).toBeLessThanOrEqual(1024 * 1024)
        if (String(url).endsWith('/begin')) {
          expect(JSON.parse(String(init?.body)).max_part_bytes).toBe(1024 * 1024)
          return Response.json({ upload_id: 'u', part_size: 1024 * 1024, parts: 2, received: [] })
        }
        return new Response(null, { status: 201 })
      },
    }
  )
  const source: ChunkSource = {
    size: bytes.length,
    async read(offset, length) {
      reads.push(offset)
      return bytes.slice(offset, offset + length)
    },
    async assertUnchanged() {},
    async close() {
      closed = true
    },
  }
  await client.putBlobSource({ size: bytes.length, sha: await sha256(bytes) }, source)
  expect(reads).toEqual([0, 1024 * 1024, 0, 1024 * 1024])
  expect(requests.at(-1)).toMatch(/complete$/)
  expect(closed).toBe(true)
})

it('does not complete if the source changes during upload', async () => {
  let assertions = 0
  let completed = false
  let closed = false
  const client = new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'https://test',
      key: 'k'.repeat(43),
      scope: { kind: 'folder', id: 'f', path: '/' },
    }),
    {
      fetch: async (url) => {
        if (String(url).endsWith('/begin'))
          return Response.json({ upload_id: 'u', part_size: 1, parts: 1, received: [] })
        if (String(url).endsWith('/complete')) completed = true
        return new Response(null, { status: 201 })
      },
    }
  )
  const source: ChunkSource = {
    size: 1,
    async read() {
      return new Uint8Array([3])
    },
    async assertUnchanged() {
      if (++assertions > 1) throw new Error('source changed')
    },
    async close() {
      closed = true
    },
  }
  await expect(
    client.putBlobSource({ size: 1, sha: await sha256(new Uint8Array([3])) }, source)
  ).rejects.toThrow('source changed')
  expect(completed).toBe(false)
  expect(closed).toBe(true)
})

it('cancels a stalled upload part and retries only that part', async () => {
  const bytes = new Uint8Array(1024 * 1024 + 7)
  const parts: number[] = []
  let closed = false
  let aborted = false
  const client = new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'https://test',
      key: 'k'.repeat(43),
      scope: { kind: 'folder', id: 'f', path: '/' },
    }),
    {
      transferStallMs: 10,
      fetch: async (url, init) => {
        const path = String(url)
        if (path.endsWith('/begin'))
          return Response.json({ upload_id: 'u', part_size: 1024 * 1024, parts: 2, received: [] })
        if (/\/u\/\d+$/.test(path)) {
          const part = Number(path.split('/').at(-1))
          parts.push(part)
          if (part === 1 && parts.length === 2)
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  aborted = true
                  reject(init.signal!.reason)
                },
                { once: true }
              )
            })
        }
        return new Response(null, { status: 201 })
      },
    }
  )
  const source: ChunkSource = {
    size: bytes.length,
    async read(at, length) {
      return bytes.slice(at, at + length)
    },
    async assertUnchanged() {},
    async close() {
      closed = true
    },
  }
  await client.putBlobSource({ size: bytes.length, sha: await sha256(bytes) }, source)
  expect(parts).toEqual([0, 1, 1])
  expect(aborted).toBe(true)
  expect(closed).toBe(true)
}, 1000)
