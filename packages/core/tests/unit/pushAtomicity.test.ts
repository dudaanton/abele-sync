import { expect, it } from 'vitest'
import {
  MemoryFileSystem,
  MemoryStateStore,
  sha256,
  ExpectedWrites,
  EngineError,
} from '../../src/index.js'
import { PushDisk } from '../../src/pushDisk.js'

it('D-091 keeps the receipt retryable when deferred equality cannot be read', async () => {
  const { push, resumeJournal, scan } = await import('../../src/index.js')
  const { StagedChanges } = await import('../../src/defer.js')
  const f = await fixture()
  await f.state.delete('old.bin')
  const found = await scan(f.fs, f.state, { excluded: () => false })
  const op = found.ops[0]!
  if (op.op !== 'create') throw new Error('expected create')
  const failure = new Error('receipt read unavailable'),
    read = f.fs.read.bind(f.fs)
  let failing = true
  const client = {
    hasBlob: async () => true,
    versions: async () => [],
    commitRaw: async () => {
      f.fs.read = async (path: string) => {
        if (failing) throw failure
        return read(path)
      }
      return {
        replayed: false,
        body: {
          head_seq: 1,
          results: [
            {
              status: 'applied',
              file_id: 'file',
              version_id: 'b',
              seq: 1,
              path: op.path,
              sha: op.sha,
              size: op.size,
              mtime: op.mtime,
            },
          ],
        },
      }
    },
  } as unknown as import('../../src/engineClient.js').EngineClient
  const staged = new StagedChanges(f.state)
  const opts = {
    expected: new ExpectedWrites(),
    defer: () => true,
    onDefer: async (items: import('../../src/defer.js').Staged[]) => {
      await staged.stage(items)
    },
  }
  await expect(push(client, f.fs, f.state, found, opts)).rejects.toBe(failure)
  expect(await f.state.getJournal()).not.toBeNull()
  expect(await staged.list()).toEqual([])
  failing = false
  await resumeJournal(client, f.fs, f.state, opts)
  expect(await f.state.getJournal()).toBeNull()
  expect(await staged.list()).toEqual([])
  expect((await f.state.get('old.bin'))?.versionId).toBe('b')
})

async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore(),
    a = new Uint8Array([1]),
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
  await fs.writeAtomic('old.bin', a, 1)
  await state.put(base)
  const disk = new PushDisk(fs, state, { expected: new ExpectedWrites() }, sha256, new Map())
  return { fs, state, a, edit, base, disk }
}

it('D-058 keeps a same-stat edited source when the receipt target already exists', async () => {
  const f = await fixture()
  await f.fs.writeAtomic('old.bin', f.edit, 1)
  await f.fs.writeAtomic('new.bin', new Uint8Array([2]), 1)
  expect(await f.disk.place(f.base, 'new.bin')).toBe(false)
  expect(await f.fs.read('old.bin')).toEqual(f.edit)
  expect(await f.state.get('old.bin')).toEqual(f.base)
})

it('D-058 refuses a move when a destination save appears after the existence check', async () => {
  const f = await fixture(),
    stat = f.fs.stat.bind(f.fs),
    move = f.fs.move.bind(f.fs)
  f.fs.stat = async (path) => {
    const result = await stat(path)
    if (path === 'new.bin' && result === null) await f.fs.writeAtomic(path, f.edit, 1)
    return result
  }
  // Model a host rename which replaces a destination, as POSIX rename does.
  f.fs.move = async (from, to) => {
    await f.fs.remove(to)
    await move(from, to)
  }
  expect(await f.disk.place(f.base, 'new.bin')).toBe(false)
  expect(await f.fs.read('new.bin')).toEqual(f.edit)
  expect(await f.fs.read('old.bin')).toEqual(f.a)
})

it('D-058 does not undo a refused rename of same-stat edited bytes', async () => {
  const f = await fixture()
  await f.fs.move('old.bin', 'new.bin')
  await f.fs.writeAtomic('new.bin', f.edit, 1)
  await f.disk.undoMove({ op: 'move', file_id: 'file', base_version_id: 'a', to_path: 'new.bin' })
  expect(await f.fs.stat('old.bin')).toBeNull()
  expect(await f.fs.read('new.bin')).toEqual(f.edit)
})

it('propagates an operational failure during push receipt respelling instead of classifying it as refused', async () => {
  const f = await fixture()
  await f.fs.writeAtomic('OLD.BIN', f.a, 1)
  const failure = new EngineError('io', 'transient respell failure')
  f.fs.conditionalFile = async () => {
    throw failure
  }
  await expect(f.disk.place(f.base, 'OLD.BIN')).rejects.toBe(failure)
  expect(await f.state.get('old.bin')).toEqual(f.base)
})
