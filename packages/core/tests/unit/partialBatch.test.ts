import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import { V2EngineClient } from '../../src/v2Client.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { scan } from '../../src/scanner.js'
import { push } from '../../src/pusher.js'
import { ExpectedWrites } from '../../src/echo.js'
import { MEMBERS_KEY } from '../../src/restoreGeneration.js'

it('D-019 records successful parts when a later restored group asset is refused', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await fs.writeAtomic('Root.md', new TextEncoder().encode('root'), 1)
  await fs.writeAtomic('Asset.bin', new Uint8Array([1]), 1)
  await state.setMeta(MEMBERS_KEY, JSON.stringify([{ wirePath: 'Asset.bin' }]))
  const found = await scan(fs, state, { excluded: () => false })
  const root = found.ops.find((op) => op.op === 'create' && op.path === 'Root.md')!
  if (root.op !== 'create') throw new Error('expected create')
  const scope = { kind: 'group' as const, id: 'root', path: 'Root.md' }
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
        if (path === '/v2/commit')
          return Response.json({
            cursor: 1,
            results: [
              {
                status: 'applied',
                file_id: 'root',
                version_id: 'v1',
                seq: 1,
                path: root.path,
                sha: root.sha,
                size: root.size,
                mtime: root.mtime,
              },
            ],
          })
        if (path === '/v2/group-assets')
          return Response.json(
            { error: { code: 'invalid_request', message: 'asset refused' } },
            { status: 400 }
          )
        if (init?.method === 'PUT') return new Response(null, { status: 201 })
        throw new Error(`unexpected ${path}`)
      },
    }
  )
  await client.prepare(fs, state)
  const result = await push(client, fs, state, found, { expected: new ExpectedWrites() })
  expect(await state.get('Root.md')).toMatchObject({
    fileId: 'root',
    versionId: 'v1',
    sha: root.sha,
  })
  expect(result.applied).toBe(1)
  expect(result.rejected).toHaveLength(1)
  expect(result.rejected[0]?.op).toMatchObject({ path: 'Asset.bin' })
  expect(await state.getJournal()).toBeNull()
})
