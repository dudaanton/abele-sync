import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import { V2EngineClient } from '../../src/v2Client.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { pull } from '../../src/puller.js'
import { sha256 } from '../../src/hash.js'

it('D-032 restores group membership for untracked files in a resumed manifest page', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bodies = [new TextEncoder().encode('root'), new Uint8Array([7])]
  const items = await Promise.all(
    bodies.map(async (body, n) => ({
      file_id: n === 0 ? 'root' : 'asset',
      version_id: `v${n}`,
      path: n === 0 ? 'Root.md' : 'Asset.bin',
      kind: n === 0 ? 'note' : 'attachment',
      sha: await sha256(body),
      size: body.length,
      mtime: 1,
    }))
  )
  const scope = { kind: 'group' as const, id: 'root', path: 'Root.md' }
  let manifests = 0
  const makeClient = () =>
    new V2EngineClient(
      encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
      {
        fetch: async (url) => {
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
          if (path === '/v2/manifest') {
            manifests++
            return Response.json({ items, next: null, cursor: 2 })
          }
          if (path === '/v2/changes') return Response.json({ items: [], next: null, cursor: 2 })
          const n = path.includes('/root/') ? 0 : 1
          return new Response(bodies[n])
        },
      }
    )
  const controller = new AbortController(),
    first = makeClient()
  await first.prepare(fs, state)
  const write = fs.writeAtomic.bind(fs)
  let writes = 0
  fs.writeAtomic = async (...args) => {
    await write(...args)
    if (++writes === 1) controller.abort()
  }
  const opts = {
    expected: new ExpectedWrites(),
    dirty: new Set<string>(),
    filter: { excluded: (path: string) => !first.includes(path) },
    signal: controller.signal,
  }
  await expect(pull(first, fs, state, opts)).rejects.toThrow()
  expect(await state.get('Root.md')).not.toBeNull()
  expect(await state.get('Asset.bin')).toBeNull()
  const resumed = makeClient()
  await resumed.prepare(fs, state)
  await pull(resumed, fs, state, {
    expected: new ExpectedWrites(),
    dirty: new Set(),
    filter: { excluded: (path) => !resumed.includes(path) },
  })
  expect(fs.snapshot().get('Asset.bin')).toEqual(bodies[1])
  expect(await state.get('Asset.bin')).toMatchObject({ fileId: 'asset' })
  expect(await state.getCursor()).toBe(2)
  expect(manifests).toBe(1)
})
