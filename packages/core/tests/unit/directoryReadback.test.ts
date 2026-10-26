import { expect, it, vi } from 'vitest'
import { encodeAccessToken, type V2Change } from '@abele/sync-protocol'
import { MemoryFileSystem, MemoryStateStore, V2EngineClient } from '../../src/index.js'
import { V2Directories } from '../../src/v2Directories.js'

const old = {
  file_id: 'directory',
  version_id: 'own-v1',
  path: 'old',
  kind: 'directory' as const,
  mtime: 1,
}
async function fixture() {
  const state = new MemoryStateStore(),
    fs = new MemoryFileSystem()
  const dirs = new Map([['old', 'inode']])
  const mkdir = vi.fn(async (path: string) => {
    dirs.set(path, dirs.get(path) ?? 'new-inode')
  })
  Object.assign(fs, {
    mkdir,
    async *listDirectories() {
      for (const [path, identity] of dirs) yield { path, identity, mtime: 1 }
    },
  })
  await state.setCursor(1)
  await state.setMeta(
    'v2-directories',
    JSON.stringify({ directories: [{ ...old, identity: 'inode' }], removals: [] })
  )
  return { state, fs, mkdir }
}
it('revokes a page-local directory echo proof after a real version change or departure', async () => {
  const { state, fs } = await fixture()
  const directories = new V2Directories(fs, state, () => true, vi.fn())
  const page = await directories.readback()
  expect(page.matches(old)).toBe(true)
  expect(page.matches({ ...old, version_id: 'remote-v2', path: 'new' })).toBe(false)
  expect(page.matches(old)).toBe(false)
  const next = await directories.readback()
  next.invalidate(old.file_id)
  expect(next.matches(old)).toBe(false)
})

it('retains placement work for an unresolved incoming directory even when its ledger version matches', async () => {
  const { state, fs } = await fixture()
  const doc = JSON.parse((await state.getMeta('v2-directories'))!)
  await state.setMeta('v2-directories', JSON.stringify({ ...doc, incoming: [old] }))
  const directories = new V2Directories(fs, state, () => true, vi.fn())
  expect((await directories.readback()).matches(old)).toBe(false)
})

it.each(['feed', 'manifest'] as const)(
  'skips exact directory echoes but places a real remote version (%s)',
  async (kind) => {
    const { state, fs, mkdir } = await fixture()
    const remote = { ...old, version_id: 'remote-v2', path: 'new', mtime: 2 }
    const scope = { kind: 'folder' as const, id: 'root', path: '/' }
    const events: V2Change[] = [old, remote].map((item, n) => ({
      type: 'content',
      item,
      file_id: item.file_id,
      path: item.path,
      prev_path: n ? 'old' : null,
      cursor: n + 2,
      at: '2026-01-01T00:00:00.000Z',
    }))
    const client = new V2EngineClient(
      encodeAccessToken({ v: 1, address: 'https://echo.test', key: 'k'.repeat(43), scope }),
      {
        fetch: async (input) => {
          const path = new URL(String(input)).pathname
          if (path === '/v2/connection')
            return Response.json({
              protocol: 2,
              token_id: 'primary',
              space_id: 'space',
              scope,
              status: 'active',
              limits: { max_file_bytes: 10000, quota_bytes: null },
            })
          return Response.json({
            items: kind === 'feed' ? events : [old, remote],
            cursor: 3,
            next: null,
          })
        },
      }
    )
    await client.prepare(fs, state, () => false, undefined, true)
    if (kind === 'feed') await client.changes(1)
    else await client.manifest(null)
    expect(mkdir.mock.calls).toEqual([['new']])
    const doc = JSON.parse((await state.getMeta('v2-directories'))!)
    expect(doc.directories).toEqual([{ ...remote, identity: 'new-inode', localPath: 'new' }])
  }
)
