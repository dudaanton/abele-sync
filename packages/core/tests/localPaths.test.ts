import { expect, it, vi } from 'vitest'
import { MemoryFileSystem } from '../src/fs.js'
import { LocalPaths, refreshLocalPaths, wirePath } from '../src/localPaths.js'
import { MemoryStateStore } from '../src/state.js'
import { encodeAccessToken } from '@abele/sync-protocol'
import { V2EngineClient } from '../src/v2Client.js'

it('does not enumerate names without possible canonical Unicode aliases', async () => {
  const fs = new MemoryFileSystem()
  const list = vi.spyOn(fs, 'list')
  const paths = await LocalPaths.forFile(fs, 'notes/0001.md')
  expect(paths.resolve('notes/0001.md', 'file')).toBe('notes/0001.md')
  expect(list).not.toHaveBeenCalled()
})

it('caches portable preflight inventories per pass while final rechecks stay fresh', async () => {
  const fs = new MemoryFileSystem()
  const list = vi.spyOn(fs, 'list')
  const pass = LocalPaths.filePass(fs, new MemoryStateStore())
  await pass('é.md')
  await pass('ö.md')
  expect(list).toHaveBeenCalledTimes(1)
  await fs.writeAtomic('e\u0301.md', new Uint8Array([1]), 1)
  expect((await LocalPaths.forFile(fs, 'é.md')).resolve('é.md', 'file')).toBe('e\u0301.md')
  expect(list).toHaveBeenCalledTimes(2)
  await LocalPaths.filePass(fs, new MemoryStateStore())('é.md')
  expect(list).toHaveBeenCalledTimes(3)
})

it.each([
  ['K.md', '\u212a.md'],
  [';.md', '\u037e.md'],
  ['`.md', '\u1fef.md'],
  ['é.md', 'e\u0301.md'],
])('still enumerates canonical aliases of %s', async (wire, local) => {
  const fs = new MemoryFileSystem()
  await fs.writeAtomic(local, new Uint8Array([1]), 1)
  const paths = await LocalPaths.forFile(fs, wire)
  expect(paths.resolve(wire, 'file')).toBe(local)
})

it('resolves mixed and partially decomposed parents and missing NFC children', async () => {
  const fs = new MemoryFileSystem()
  const parent = 'й'.normalize('NFD') + '/ё-é'
  await fs.writeAtomic(parent + '/existing.md', new Uint8Array(), 1)
  const paths = await LocalPaths.read(fs)
  expect(paths.resolve('й/ё-é/new.md', 'file')).toBe(parent + '/new.md')
  expect(paths.resolve('й/ё-é/existing.md', 'file')).toBe(parent + '/existing.md')
})

it('retains all directory and file/directory twins and blocks their canonical subtree', async () => {
  const fs = new MemoryFileSystem()
  await fs.writeAtomic('й/a.md', new Uint8Array([1]), 1)
  await fs.writeAtomic('й'.normalize('NFD') + '/b.md', new Uint8Array([2]), 1)
  const paths = await LocalPaths.read(fs)
  expect(() => paths.resolve('й/new.md', 'file')).toThrow(/normalization collision.*U\+/)
  expect(paths.resolve('safe/new.md', 'file')).toBe('safe/new.md')
  expect(fs.snapshot().size).toBe(2)
})

it('composes only Unicode, preserving case and all structural validation', () => {
  expect(wirePath('Й/ё-é'.normalize('NFD'))).toBe('Й/ё-é')
  for (const path of ['/a', './a', 'a/../b', 'a\\b', 'a//b', 'a/'])
    expect(() => wirePath(path)).toThrow()
  expect(wirePath('ё'.repeat(120).normalize('NFD'))).toBe('ё'.repeat(120))
})

it('compares scoped inputs in NFC without widening case or segment boundaries', () => {
  const client = new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'http://127.0.0.1:1234',
      key: 'a'.repeat(43),
      scope: { kind: 'folder', id: 'synthetic', path: 'й-folder' },
    }),
    { fetch }
  )
  expect(client.includes('й-folder'.normalize('NFD'))).toBe(true)
  expect(client.includes('й-folder/ё.md'.normalize('NFD'))).toBe(true)
  expect(client.includes('й-folder-other/ё.md')).toBe(false)
  expect(client.includes('Й-folder/ё.md')).toBe(false)
})

it('atomically refreshes a normalization-only file key while preserving IDs and pending evidence', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const original = {
    path: 'й/ё.md',
    wirePath: 'й/ё.md',
    fileId: 'id',
    versionId: 'v1',
    sha: 'a'.repeat(64),
    size: 1,
    mtime: 1,
  }
  await fs.writeAtomic(original.path, new Uint8Array([1]), 1)
  await state.put(original)
  const raw = original.path.normalize('NFD')
  await fs.move(original.path, raw)
  await refreshLocalPaths(fs, state)
  expect(await state.get(original.path)).toBeNull()
  expect(await state.byFileId('id')).toEqual({ ...original, path: raw })
  const all = []
  for await (const entry of state.all()) all.push(entry)
  expect(all).toHaveLength(1)
  await state.setMeta('pull-write:id', 'physical provenance')
  await fs.move(raw, original.path)
  await refreshLocalPaths(fs, state)
  expect(await state.byFileId('id')).toMatchObject({ path: raw })
  expect(await state.getMeta('pull-write:id')).toBe('physical provenance')
})

it('blocks empty directory twins and file/directory aliases without touching bytes', async () => {
  class Directories extends MemoryFileSystem {
    async *listDirectories() {
      yield { path: 'й'.normalize('NFD'), identity: 'empty', mtime: 1 }
    }
  }
  const fs = new Directories()
  await fs.writeAtomic('й', new Uint8Array([7]), 1)
  const paths = await LocalPaths.read(fs)
  expect(() => paths.resolve('й/child.md', 'file')).toThrow(/normalization collision/)
  expect(await fs.read('й')).toEqual(new Uint8Array([7]))
})
