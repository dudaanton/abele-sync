import { expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { PendingPullWrites } from '../../src/pullWrite.js'
import { pull, applyStaged } from '../../src/puller.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'
import { PullPlacer } from '../../src/pullPlace.js'
import { pathOccupant } from '../../src/pathOccupant.js'

async function fixture(path = 'new.bin', caseInsensitive = false, normalizing = false) {
  const fs = new MemoryFileSystem({ caseInsensitive, normalizing }),
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

it('D-154 staged move holds when another identity owns a case alias', async () => {
  const f = await fixture('NOTE.bin', true)
  f.change.path = 'note.bin'
  await new PendingPullWrites(f.state).prepare(f.change, f.source, 'note.bin', 'old.bin')
  const report = await applyStaged(f.client, f.fs, f.state, [f.change], f.options)
  expect(report.held).toEqual([f.change])
  expect(report.applied).toBe(0)
  expect(await f.state.byFileId('A')).toEqual(f.source)
  expect(await f.state.byFileId('B')).toEqual(f.occupant)
  expect(await f.fs.read('NOTE.bin')).toEqual(f.bytes)
})

it.each(['case', 'normalizing'] as const)(
  'D-154 %s aliases are fenced again at ledger publication',
  async (mode) => {
    const path = mode === 'case' ? 'NOTE.bin' : 'Cafe\u0301.bin'
    const target = mode === 'case' ? 'note.bin' : 'Café.bin'
    const f = await fixture(path, mode === 'case', mode === 'normalizing')
    f.change.path = target
    await new PendingPullWrites(f.state).prepare(
      f.change,
      f.source,
      mode === 'case' ? target : path,
      'old.bin'
    )
    await f.state.delete(path)
    const read = f.fs.read.bind(f.fs)
    f.fs.read = async (name) => {
      const bytes = await read(name)
      await f.state.put(f.occupant)
      return bytes
    }
    const placer = new PullPlacer(f.client, f.fs, f.state, f.options, sha256)
    expect(await placer.adoptExisting(f.change, f.source, true)).toBe(false)
    expect(await f.state.byFileId('A')).toEqual(f.source)
    expect(await f.state.byFileId('B')).toEqual(f.occupant)
  }
)

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

it('D-154 physical keys preserve distinct names on exact and normalization-only hosts', async () => {
  for (const mode of ['exact', 'normalizing', 'case']) {
    const f = await fixture('NOTE.bin', mode === 'case', mode === 'normalizing')
    expect(await pathOccupant(f.fs, f.state, 'note.bin', 'A')).toEqual(
      mode === 'case' ? f.occupant : null
    )
    await f.state.transaction(async (tx) => {
      await tx.delete('NOTE.bin')
      expect(await pathOccupant(f.fs, tx, 'NOTE.bin', 'A')).toBeNull()
      await tx.put({ ...f.occupant, path: 'note.bin' })
      expect((await pathOccupant(f.fs, tx, 'note.bin', 'A'))?.fileId).toBe('B')
    })
    expect((await pathOccupant(f.fs, f.state, 'note.bin', 'A'))?.fileId).toBe('B')
  }
})

it('D-154 candidate indexing follows a host fold broader than protocol caseKey', async () => {
  const f = await fixture('straße.bin')
  f.fs.pathKey = (path) => path.normalize('NFC').toLowerCase().replaceAll('ß', 'ss')
  expect(await pathOccupant(f.fs, f.state, 'strasse.bin', 'A')).toEqual(f.occupant)
  await f.state.transaction(async (tx) => {
    expect(await pathOccupant(f.fs, tx, 'strasse.bin', 'A')).toEqual(f.occupant)
  })
})

it('D-151 operational failure in staged target resolution remains retryable', async () => {
  const f = await fixture('Café.bin')
  const failure = new Error('temporary inventory read failure')
  const original = PullPlacer.prototype.targetOf
  PullPlacer.prototype.targetOf = async () => {
    throw failure
  }
  try {
    await expect(applyStaged(f.client, f.fs, f.state, [f.change], f.options)).rejects.toBe(failure)
    expect(await f.state.getMeta('pull-write:A')).not.toBeNull()
  } finally {
    PullPlacer.prototype.targetOf = original
  }
})

it('D-151 a staged normalization collision holds one item and still applies the next', async () => {
  const f = await fixture('Café.bin')
  await f.fs.writeAtomic('Cafe\u0301.bin', new Uint8Array([2]), 1)
  const good = {
    ...f.change,
    file_id: 'C',
    version_id: 'c1',
    path: 'good.bin',
    prev_path: null,
    op: 'create' as const,
    seq: 3,
  }
  const report = await applyStaged(f.client, f.fs, f.state, [f.change, good], f.options)
  expect(report.held).toEqual([f.change])
  expect(report.applied).toBe(1)
  expect(await f.fs.read('good.bin')).toEqual(f.bytes)
  expect(await f.state.get('Café.bin')).toEqual(f.occupant)
  expect(await f.fs.read('Cafe\u0301.bin')).toEqual(new Uint8Array([2]))
})

it('pull/adoption/staged retries preserve contending identities across alias path pools', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('new.bin', 'Café.bin', 'Cafe\u0301.bin', 'NOTE.bin', 'note.bin'),
      fc.constantFrom('exact', 'case', 'normalizing'),
      fc.boolean(),
      fc.array(fc.boolean(), { minLength: 2, maxLength: 8 }),
      async (path, mode, collision, stagedOrder) => {
        const insensitive = mode === 'case'
        const f = await fixture(path, insensitive, mode === 'normalizing')
        // Exercise different requested and ledger spellings of ONE physical file.
        if (insensitive) f.change.path = path.toLowerCase().normalize('NFC')
        if (mode === 'normalizing') f.change.path = path.normalize('NFC')
        await new PendingPullWrites(f.state).prepare(f.change, f.source, f.change.path, 'old.bin')
        if (collision && mode === 'exact' && path.normalize('NFC') === 'Café.bin')
          await f.fs.writeAtomic(
            path === 'Café.bin' ? 'Cafe\u0301.bin' : 'Café.bin',
            new Uint8Array([2]),
            1
          )
        if (collision && /^(NOTE|note)\.bin$/.test(path))
          await f.fs.writeAtomic(path === 'NOTE.bin' ? 'note.bin' : 'NOTE.bin', f.bytes, 1)
        for (const staged of stagedOrder) {
          const good = {
            ...f.change,
            file_id: 'C',
            version_id: 'c1',
            path: 'good.bin',
            prev_path: null,
            op: 'create' as const,
            seq: 3,
          }
          f.client.changes = async () => ({ items: [f.change, good], head_seq: 3, next_since: 3 })
          const report = staged
            ? await applyStaged(f.client, f.fs, f.state, [f.change, good], f.options)
            : await pull(f.client, f.fs, f.state, f.options)
          expect(report.held).toContainEqual(f.change)
          expect(await f.state.byFileId('A')).toEqual(f.source)
          expect(await f.state.get(path)).toEqual(f.occupant)
          expect(await f.fs.read(path)).toEqual(f.bytes)
          expect(await f.fs.read('good.bin')).toEqual(f.bytes)
        }
      }
    ),
    { seed: 150151, numRuns: 80 }
  )
})
