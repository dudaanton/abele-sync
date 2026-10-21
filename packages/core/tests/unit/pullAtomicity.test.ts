import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem, MemoryStateStore, sha256, ExpectedWrites } from '../../src/index.js'
import { PullPlacer } from '../../src/pullPlace.js'
import { ScopeMarks } from '../../src/scope.js'
import { recoverPendingPullWrites } from '../../src/pullRecovery.js'

async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const a = new Uint8Array([1]),
    b = new Uint8Array([2]),
    edit = new Uint8Array([3])
  const base = {
    path: 'old.bin',
    wirePath: 'old.bin',
    fileId: 'file',
    versionId: 'a',
    sha: await sha256(a),
    size: 1,
    mtime: 1,
  }
  await state.put(base)
  await fs.writeAtomic(base.path, a, 1)
  const change: ChangeItem = {
    seq: 2,
    file_id: 'file',
    version_id: 'b',
    path: 'old.bin',
    prev_path: null,
    op: 'modify',
    sha: await sha256(b),
    size: 1,
    mtime: 1,
    kind: 'attachment',
    actor: { kind: 'system', id: 'server', name: 'server' },
    at: '',
  }
  const placer = new PullPlacer(
    { getBlob: async () => b },
    fs,
    state,
    { dirty: new Set(), expected: new ExpectedWrites(), filter: { excluded: () => false } },
    sha256
  )
  return { fs, state, a, b, edit, base, change, placer }
}

it('scope widening retains the missing source base protecting an offline rename/edit', async () => {
  const f = await fixture(),
    marks = new ScopeMarks(f.state)
  await marks.review(f.fs, { excluded: () => true })
  await f.fs.move('old.bin', 'new.bin')
  await f.fs.writeAtomic('new.bin', f.b, 1)
  await marks.review(f.fs, { excluded: () => false })
  expect(await f.state.get('old.bin')).toEqual(f.base)
  expect(
    await f.placer.adoptExisting(
      { ...f.change, path: 'new.bin', op: 'move', prev_path: 'old.bin' },
      await f.state.byFileId('file')
    )
  ).toBe(false)
  expect(await f.fs.read('new.bin')).toEqual(f.b)
})

it('does not adopt a pre-write intent when the user independently saved the planned bytes', async () => {
  const f = await fixture()
  await f.placer.pending.prepare(f.change, f.base, 'old.bin', null)
  await f.fs.writeAtomic('old.bin', f.b, 1)
  await recoverPendingPullWrites(f.fs, f.state, ['file'])
  expect(await f.state.get('old.bin')).toEqual(f.base)
  expect(
    await f.placer.place(
      { ...f.change, version_id: 'c', sha: await sha256(f.edit) },
      await sha256(f.edit),
      f.base,
      new Map(),
      new Map()
    )
  ).toBe(false)
  expect(await f.fs.read('old.bin')).toEqual(f.b)
})

it('equal-target adoption cannot remove a source edited during destination hashing', async () => {
  const f = await fixture()
  await f.fs.writeAtomic('new.bin', f.b, 1)
  const read = f.fs.read.bind(f.fs)
  f.fs.read = async (path) => {
    const bytes = await read(path)
    if (path === 'new.bin') await f.fs.writeAtomic('old.bin', f.edit, 1)
    return bytes
  }
  expect(
    await f.placer.place(
      { ...f.change, path: 'new.bin', op: 'move', prev_path: 'old.bin' },
      f.change.sha!,
      f.base,
      new Map(),
      new Map()
    )
  ).toBe(false)
  expect(await f.fs.read('old.bin')).toEqual(f.edit)
})

it('eviction preserves an edit made while its intent is saved', async () => {
  const f = await fixture(),
    put = f.state.setMeta.bind(f.state)
  f.state.setMeta = async (key, value) => {
    await put(key, value)
    if (key === 'pull-evict:file' && value !== null) await f.fs.writeAtomic('old.bin', f.edit, 1)
  }
  expect(
    await f.placer.place(
      { ...f.change, file_id: 'incoming' },
      f.change.sha!,
      null,
      new Map(),
      new Map()
    )
  ).toBe(false)
  expect(await f.fs.read('old.bin')).toEqual(f.edit)
})

it('retains removal provenance when a new equal save appears during ledger retirement', async () => {
  const f = await fixture(),
    drop = f.state.delete.bind(f.state)
  f.state.delete = async (path) => {
    await drop(path)
    await f.fs.writeAtomic(path, f.b, 1)
  }
  const incoming = { ...f.change, file_id: 'incoming' }
  expect(await f.placer.place(incoming, incoming.sha!, null, new Map(), new Map())).toBe(false)
  // Retry must not classify the newly created local B as a completed remote B.
  expect(await f.placer.adoptExisting(incoming, null)).toBe(false)
  expect(await f.fs.read('old.bin')).toEqual(f.b)
})

it('remote deletion preserves an edit made during its path recheck', async () => {
  const f = await fixture(),
    get = f.state.getMeta.bind(f.state)
  f.state.getMeta = async (key) => {
    const value = await get(key)
    if (key === 'normalization-directory-collisions') await f.fs.writeAtomic('old.bin', f.edit, 1)
    return value
  }
  expect(await f.placer.drop(f.base)).toBe(false)
  expect(await f.fs.read('old.bin')).toEqual(f.edit)
})

it('buffered publication preserves an edit made during the final path recheck', async () => {
  const f = await fixture(),
    get = f.state.getMeta.bind(f.state)
  let armed = false
  const put = f.state.setMeta.bind(f.state)
  f.state.setMeta = async (key, value) => {
    await put(key, value)
    if (key === 'pull-write:file' && value !== null) armed = true
  }
  f.state.getMeta = async (key) => {
    const value = await get(key)
    if (armed && key === 'normalization-directory-collisions')
      await f.fs.writeAtomic('old.bin', f.edit, 1)
    return value
  }
  expect(await f.placer.place(f.change, f.change.sha!, f.base, new Map(), new Map())).toBe(false)
  expect(await f.fs.read('old.bin')).toEqual(f.edit)
})
