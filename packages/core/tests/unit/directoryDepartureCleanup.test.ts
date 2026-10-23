import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, V2EngineClient } from '../../src/index.js'
import { captureDepartures, dispatchDepartures } from '../../src/departureSettlement.js'

it.each([false, true])(
  'D-205 cleans a departed empty directory only when user-included, across restart (excluded=%s)',
  async (excluded) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const path = 'Root/empty',
      identity = 'directory-instance'
    const directories = new Map([[path, identity]])
    const remove = vi.fn(async (name: string, expected: string) => {
      expect(directories.get(name)).toBe(expected)
      directories.delete(name)
    })
    Object.assign(fs, {
      listDirectories: async function* () {
        for (const [path, identity] of directories) yield { path, identity, mtime: 1 }
      },
      removeDirectory: remove,
    })
    await state.setCursor(1)
    await state.setMeta(
      'v2-directories',
      JSON.stringify({
        directories: [
          { file_id: 'directory', version_id: 'v1', path, kind: 'directory', identity, mtime: 1 },
        ],
        removals: [],
      })
    )
    const scope = { kind: 'folder' as const, id: 'root', path: 'Root' }
    const token = encodeAccessToken({
      v: 1,
      address: 'https://example.test',
      key: 'k'.repeat(43),
      scope,
    })
    const makeClient = () =>
      new V2EngineClient(token, {
        fetch: async (url) =>
          new URL(String(url)).pathname === '/v2/connection'
            ? Response.json({
                protocol: 2,
                token_id: 'token',
                space_id: 'space',
                scope,
                status: 'active',
                limits: { max_file_bytes: 10000, quota_bytes: null },
              })
            : Response.json({
                items: [
                  {
                    type: 'removal',
                    file_id: 'directory',
                    path,
                    cursor: 2,
                    at: '2026-01-01T00:00:00.000Z',
                  },
                ],
                cursor: 2,
                next: null,
              }),
      })
    let client = makeClient()
    await client.prepare(fs, state, () => excluded, undefined, true)
    const page = await client.changes(1)
    await captureDepartures(state, page.departures)
    await dispatchDepartures(state, client)
    expect(client.includes(path)).toBe(false)
    // Restart after queuing cleanup but before finishPull, with durable departures.
    client = makeClient()
    await client.prepare(fs, state, () => excluded, undefined, true)
    expect(client.includes(path)).toBe(false)
    await client.finishPull()
    client = makeClient()
    await client.prepare(fs, state, () => excluded, undefined, true)
    await client.finishPull()
    expect(remove).toHaveBeenCalledTimes(excluded ? 0 : 1)
    expect(directories.has(path)).toBe(excluded)
    const doc = JSON.parse((await state.getMeta('v2-directories'))!)
    expect(doc.removals).toEqual([])
    expect(doc.directories).toHaveLength(excluded ? 1 : 0)
  }
)
