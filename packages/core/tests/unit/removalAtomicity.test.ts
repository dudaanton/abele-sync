import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import { V2EngineClient, MemoryFileSystem, MemoryStateStore, sha256 } from '../../src/index.js'

it('V2 removal refuses a save at the filesystem effect boundary and retains its base', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const original = new Uint8Array([1]),
    edit = new Uint8Array([3])
  await fs.writeAtomic('Root.md', original, 1)
  const base = {
    path: 'Root.md',
    wirePath: 'Root.md',
    fileId: 'root',
    versionId: 'a',
    sha: await sha256(original),
    size: 1,
    mtime: 1,
  }
  await state.put(base)
  const scope = { kind: 'group' as const, id: 'root', path: 'Root.md' }
  const client = new V2EngineClient(
    encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
    {
      fetch: async (url) => {
        if (new URL(String(url)).pathname === '/v2/connection')
          return Response.json({
            protocol: 2,
            token_id: 'token',
            space_id: 'space',
            scope,
            status: 'active',
            limits: { max_file_bytes: 10000, quota_bytes: null },
          })
        return Response.json({
          items: [
            {
              type: 'removal',
              file_id: 'root',
              path: 'Root.md',
              cursor: 2,
              at: '2026-01-01T00:00:00.000Z',
            },
          ],
          next: null,
          cursor: 2,
        })
      },
    }
  )
  await client.prepare(fs, state, () => false, undefined, true)
  let injected = false
  const remove = fs.remove.bind(fs),
    conditional = fs.conditionalFile.bind(fs)
  fs.remove = async (path) => {
    injected = true
    await fs.writeAtomic(path, edit, 1)
    await remove(path)
  }
  fs.conditionalFile = async (op) => {
    injected = true
    await fs.writeAtomic(op.path, edit, 1)
    return conditional(op)
  }
  await client.changes(1)
  expect(injected).toBe(true)
  expect(await fs.read('Root.md')).toEqual(edit)
  expect(await state.get('Root.md')).toEqual(base)
})
