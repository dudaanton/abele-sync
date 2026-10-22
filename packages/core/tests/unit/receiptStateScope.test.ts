import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import {
  V2EngineClient,
  MemoryFileSystem,
  MemoryStateStore,
  ExpectedWrites,
  sha256,
  scan,
  push,
} from '../../src/index.js'

it('settles later buffered V2 receipt runs without a captured-root manifest lookup', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const local = [new Uint8Array([1]), new Uint8Array([2])]
  const remote = [local[0]!, new Uint8Array([3, 4])]
  const items = await Promise.all(
    remote.map(async (bytes, n) => ({
      file_id: `f${n}`,
      version_id: `v${n}`,
      path: `${n}.bin`,
      kind: 'attachment' as const,
      sha: await sha256(bytes),
      size: bytes.length,
      mtime: 2,
    }))
  )
  for (let n = 0; n < local.length; n++) await fs.writeAtomic(`${n}.bin`, local[n]!, 1)
  const found = await scan(fs, state, { excluded: () => false })
  const scope = { kind: 'folder' as const, id: 'folder', path: '/' }
  let manifests = 0,
    content = 0
  const client = new V2EngineClient(
    encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
    {
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname
        if (path === '/v2/connection')
          return Response.json({
            protocol: 2,
            token_id: 'token',
            space_id: 'space',
            scope,
            status: 'active',
            limits: { max_file_bytes: 10000, quota_bytes: null },
          })
        if (path.startsWith('/v2/uploads/')) return new Response(null, { status: 204 })
        if (path === '/v2/commit')
          return Response.json({
            cursor: 2,
            results: items.map(({ kind: _, ...item }, n) => ({
              ...item,
              status: 'merged',
              seq: n + 1,
            })),
          })
        if (path === '/v2/manifest') {
          manifests++
          return Response.json({ items, next: null, cursor: 2 })
        }
        if (path === '/v2/files/f1/content') {
          content++
          return new Response(remote[1])
        }
        throw new Error(`unexpected request ${init?.method} ${path}`)
      },
    }
  )
  await client.prepare(fs, state, () => false, undefined, true)
  const report = await push(client, fs, state, found, {
    expected: new ExpectedWrites(),
    prefetchBytes: 1,
  })
  expect(report.merged).toBe(2)
  expect(await state.getJournal()).toBeNull()
  expect(await state.get('0.bin')).toMatchObject({ versionId: 'v0' })
  expect(await state.get('1.bin')).toMatchObject({ versionId: 'v1' })
  expect(await fs.read('1.bin')).toEqual(remote[1])
  expect(manifests).toBe(0)
  expect(content).toBe(1)
})
