import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import { V2EngineClient } from '../../src/v2Client.js'
import { MAX_CHUNK_BYTES, type ChunkSource } from '../../src/streaming.js'

it('hashes and resumes a virtual multi-GiB upload with bounded reads and request bodies', async () => {
  const size = 2 * 1024 ** 3 + 7
  const sha = '4faf054bcce4f3f1718586ceb36106e28a780ea261ba3c7fc1c8519d048f9b2f'
  const parts = Math.ceil(size / MAX_CHUNK_BYTES)
  let buffer: Uint8Array | undefined
  let live = 0,
    peak = 0,
    reads = 0,
    sent = 0,
    uploaded = 0,
    completed = false
  const source: ChunkSource = {
    size,
    async read(at, length) {
      expect(length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
      expect(at + length).toBeLessThanOrEqual(size)
      reads++
      if (!buffer) {
        buffer = new Uint8Array(MAX_CHUNK_BYTES)
        live += buffer.byteLength
        peak = Math.max(peak, live)
      }
      return buffer.subarray(0, length)
    },
    async assertUnchanged() {},
    async close() {
      if (buffer) live -= buffer.byteLength
      buffer = undefined
    },
  }
  const client = new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'https://test',
      key: 'k'.repeat(43),
      scope: { kind: 'folder', id: 'f', path: '/' },
    }),
    {
      fetch: async (url, init) => {
        const path = String(url)
        if (path.endsWith('/begin')) {
          expect(JSON.parse(String(init?.body))).toEqual({ size, max_part_bytes: MAX_CHUNK_BYTES })
          return Response.json({
            upload_id: 'resumed',
            part_size: MAX_CHUNK_BYTES,
            parts,
            received: [0],
          })
        }
        if (init?.body instanceof Uint8Array) {
          expect(init.body.byteLength).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
          expect(init.body.buffer.byteLength).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
          expect(Number(path.split('/').at(-1))).toBe(sent + 1)
          uploaded += init.body.byteLength
          sent++
        }
        if (path.endsWith('/complete')) completed = true
        return new Response(null, { status: 201 })
      },
    }
  )
  await client.putBlobSource({ size, sha }, source)
  expect(reads).toBe(2 * parts)
  expect(sent).toBe(parts - 1)
  expect(uploaded).toBe(size - MAX_CHUNK_BYTES)
  expect(completed).toBe(true)
  expect(peak).toBe(MAX_CHUNK_BYTES)
  expect(live).toBe(0)
}, 120_000)
