import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { PendingPullWrites } from '../../src/pullWrite.js'
import { pull } from '../../src/puller.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'
import { PullPlacer } from '../../src/pullPlace.js'

async function fixture(path = 'new.bin', caseInsensitive = false) {
  const fs = new MemoryFileSystem({ caseInsensitive }),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  const source = {
    path: 'old.bin',
    wirePath: 'old.bin',
    fileId: 'A',
    versionId: 'v0',
    sha,
    size: 1,
    mtime: 1,
  }
  const occupant = {
    ...source,
    path,
    wirePath: path.normalize('NFC'),
    fileId: 'B',
    versionId: 'v3',
  }
  await state.put(source)
  await state.put(occupant)
  await state.setCursor(1)
  await fs.writeAtomic(path, bytes, 1)
  const change: ChangeItem = {
    file_id: 'A',
    version_id: 'v1',
    path: path.normalize('NFC'),
    prev_path: 'old.bin',
    op: 'move',
    seq: 2,
    sha,
    size: 1,
    mtime: 1,
    kind: 'attachment',
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  await new PendingPullWrites(state).prepare(change, source, path, 'old.bin')
  const client = {
    getBlob: vi.fn(async () => bytes),
    changes: async () => ({ items: [change], head_seq: 2, next_since: 2 }),
  } as unknown as EngineClient
  const options = {
    expected: new ExpectedWrites(),
    dirty: new Set<string>(),
    filter: { excluded: () => false },
  }
  return { fs, state, bytes, source, occupant, change, client, options }
}

it('D-150 pending move cannot adopt another identity through equal bytes', async () => {
  const f = await fixture()
  const report = await pull(f.client, f.fs, f.state, f.options)
  expect(report.held).toEqual([f.change])
  expect(report.applied).toBe(0)
  expect(await f.state.byFileId('A')).toEqual(f.source)
  expect(await f.state.get('new.bin')).toEqual(f.occupant)
  expect(await f.fs.read('new.bin')).toEqual(f.bytes)
  expect(await f.state.getMeta('pull-write:A')).not.toBeNull()
  expect(f.client.getBlob).not.toHaveBeenCalled()
})

it('D-150 adoption rechecks a replacement identity introduced during hashing', async () => {
  const f = await fixture()
  await f.state.delete('new.bin')
  const read = f.fs.read.bind(f.fs)
  f.fs.read = async (path) => {
    const bytes = await read(path)
    await f.state.put(f.occupant)
    return bytes
  }
  const placer = new PullPlacer(f.client, f.fs, f.state, f.options, sha256)
  expect(await placer.adoptExisting(f.change, f.source, true)).toBe(false)
  expect(await f.state.get('new.bin')).toEqual(f.occupant)
  expect(await f.state.byFileId('A')).toEqual(f.source)
  expect(await f.state.getMeta('pull-write:A')).not.toBeNull()
})
