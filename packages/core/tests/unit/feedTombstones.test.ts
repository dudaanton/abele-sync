import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it, vi } from 'vitest'
import { V2EngineClient, MemoryFileSystem, MemoryStateStore, sha256 } from '../../src/index.js'
import { pull } from '../../src/puller.js'
import { ExpectedWrites } from '../../src/echo.js'
import { StagedChanges } from '../../src/defer.js'

it.each(['installed', 'incoming'] as const)(
  'a known %s directory tombstone never enters plugin file staging',
  async (known) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const path = '.obsidian/plugins/example/assets'
    const directory = {
      file_id: 'directory',
      version_id: 'created',
      path,
      kind: 'directory' as const,
      mtime: 1,
    }
    await state.setCursor(1)
    await state.setMeta(
      'v2-directories',
      JSON.stringify({
        directories:
          known === 'installed' ? [{ ...directory, identity: 'directory-instance' }] : [],
        incoming: known === 'incoming' ? [directory] : [],
        removals: [],
      })
    )
    const scope = { kind: 'folder' as const, id: 'root', path: 'Root' }
    const client = new V2EngineClient(
      encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
      {
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
                    type: 'delete',
                    file_id: directory.file_id,
                    path,
                    version_id: 'deleted',
                    cursor: 2,
                    at: '2026-01-01T00:00:00.000Z',
                  },
                ],
                cursor: 2,
                next: null,
              }),
      }
    )
    await client.prepare(fs, state, () => false, undefined, true)
    const staged = new StagedChanges(state)
    await pull(client, fs, state, {
      expected: new ExpectedWrites(),
      dirty: new Set(),
      filter: { excluded: () => false },
      defer: () => true,
      onDefer: (items) => staged.stage(items),
    })
    expect(await staged.list()).toEqual([])
    expect(await state.getCursor()).toBe(2)
    const doc = JSON.parse((await state.getMeta('v2-directories'))!)
    expect(doc.directories).toEqual([])
    expect(doc.incoming).toEqual([])
    expect(doc.removals).toHaveLength(known === 'installed' ? 1 : 0)
  }
)

it('applies creation before requesting its tombstone on a later V2 page', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await state.setCursor(1)
  const scope = { kind: 'folder' as const, id: 'root', path: 'Root' }
  const item = {
    file_id: 'file',
    version_id: 'created',
    path: 'a.bin',
    kind: 'attachment',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
  }
  const at = '2026-01-01T00:00:00.000Z'
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const address = new URL(String(url))
    if (address.pathname === '/v2/connection')
      return Response.json({
        protocol: 2,
        token_id: 'token',
        space_id: 'space',
        scope,
        status: 'active',
        limits: { max_file_bytes: 10000, quota_bytes: null },
      })
    if (address.pathname === '/v2/changes') {
      const since = Number(address.searchParams.get('since'))
      if (since === 2) {
        expect(await fs.read('a.bin')).toEqual(new Uint8Array([1]))
        expect(await state.byFileId('file')).toMatchObject({ versionId: 'created' })
      }
      return Response.json({
        items:
          since === 1
            ? [
                {
                  type: 'content',
                  file_id: 'file',
                  path: 'a.bin',
                  item,
                  prev_path: null,
                  cursor: 2,
                  at,
                },
              ]
            : since === 2
              ? [
                  {
                    type: 'delete',
                    file_id: 'file',
                    path: 'a.bin',
                    version_id: 'deleted',
                    cursor: 3,
                    at,
                  },
                ]
              : [],
        cursor: since === 1 ? 2 : 3,
        next: since === 1 ? '2' : null,
      })
    }
    return new Response(new Uint8Array([1]))
  })
  const client = new V2EngineClient(
    encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
    { fetch: fetcher }
  )
  await client.prepare(fs, state, () => false, undefined, true)
  await pull(client, fs, state, {
    expected: new ExpectedWrites(),
    dirty: new Set(),
    filter: { excluded: () => false },
  })
  expect(await fs.stat('a.bin')).toBeNull()
  expect(await state.byFileId('file')).toBeNull()
  expect(await state.getCursor()).toBe(3)
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/content'))).toHaveLength(1)
})
