import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { applyStaged, pull } from '../../src/puller.js'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'

it.each([1, 3])(
  'holds a same-stat edit after a buffered rename carrying byte %i',
  async (value) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const old = new Uint8Array([1]),
      edit = new Uint8Array([2]),
      remote = new Uint8Array([value])
    await fs.writeAtomic('old.bin', old, 1)
    await state.put({
      path: 'old.bin',
      wirePath: 'old.bin',
      fileId: 'file',
      versionId: 'a',
      sha: await sha256(old),
      size: 1,
      mtime: 1,
    })
    const move = fs.move.bind(fs)
    fs.move = async (from, to) => {
      await move(from, to)
      await fs.writeAtomic(to, edit, 1)
    }
    const change: ChangeItem = {
      seq: 2,
      file_id: 'file',
      version_id: 'c',
      path: 'new.bin',
      prev_path: 'old.bin',
      op: 'move',
      sha: await sha256(remote),
      size: 1,
      mtime: 1,
      kind: 'attachment',
      actor: { kind: 'system', id: 'server', name: 'server' },
      at: '',
    }
    const report = await applyStaged(
      { getBlob: async () => remote } as unknown as EngineClient,
      fs,
      state,
      [change],
      { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } }
    )
    expect(await fs.read('new.bin')).toEqual(edit)
    expect(await state.get('old.bin')).toMatchObject({ versionId: 'a' })
    expect(await state.get('new.bin')).toBeNull()
    expect(report.held).toHaveLength(1)
  }
)

it.each([true, false])(
  'protects offline rename-and-edit with protectMissing=%s',
  async (protectMissing) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = [1, 2, 3].map((n) => new Uint8Array([n]))
    const hashes = await Promise.all(bytes.map(sha256))
    await fs.writeAtomic('new.bin', bytes[1]!, 1)
    await state.put({
      path: 'old.bin',
      wirePath: 'old.bin',
      fileId: 'file',
      versionId: 'a',
      sha: hashes[0]!,
      size: 1,
      mtime: 1,
    })
    await state.setCursor(1)
    const base: ChangeItem = {
      seq: 2,
      file_id: 'file',
      version_id: 'b',
      path: 'old.bin',
      prev_path: null,
      op: 'modify',
      sha: hashes[1]!,
      size: 1,
      mtime: 1,
      kind: 'attachment',
      actor: { kind: 'system', id: 'server', name: 'server' },
      at: '',
    }
    const move: ChangeItem = {
      ...base,
      seq: 3,
      version_id: 'move-b',
      path: 'new.bin',
      prev_path: 'old.bin',
      op: 'move',
    }
    const later: ChangeItem = {
      ...move,
      seq: 4,
      version_id: 'c',
      prev_path: null,
      op: 'modify',
      sha: hashes[2]!,
    }
    const client = {
      changes: async (since: number) => ({
        items: since < 3 ? [base, move] : since < 4 ? [later] : [],
        next_since: since < 3 ? 3 : 4,
        head_seq: 4,
      }),
      getBlob: async (sha: string) => bytes[hashes.indexOf(sha)]!,
    } as unknown as EngineClient
    const report = await pull(client, fs, state, {
      expected: new ExpectedWrites(),
      dirty: new Set(),
      protectMissing,
      filter: { excluded: () => false },
    })
    expect(await fs.read('new.bin')).toEqual(bytes[1])
    expect(await fs.stat('old.bin')).toBeNull()
    expect(await state.get('old.bin')).toMatchObject({ versionId: 'a', sha: hashes[0] })
    expect(await state.get('new.bin')).toBeNull()
    expect(report.held.map((c) => c.seq)).toContain(4)
    expect(await state.getCursor()).toBeLessThan(4)
  }
)

it('holds an unseen offline edit matching an intermediate feed page', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = [1, 2, 3].map((n) => new Uint8Array([n]))
  const hashes = await Promise.all(bytes.map(sha256))
  await fs.writeAtomic('file.bin', bytes[1]!, 1)
  await state.put({
    path: 'file.bin',
    wirePath: 'file.bin',
    fileId: 'file',
    versionId: 'a',
    sha: hashes[0]!,
    size: 1,
    mtime: 1,
  })
  await state.setCursor(1)
  const changes = hashes.slice(1).map((sha, n): ChangeItem => ({
    seq: n + 2,
    file_id: 'file',
    version_id: `v${n}`,
    path: 'file.bin',
    prev_path: null,
    op: 'modify',
    sha,
    size: 1,
    mtime: 1,
    kind: 'attachment',
    actor: { kind: 'system', id: 'server', name: 'server' },
    at: '',
  }))
  const getBlob = vi.fn(async (sha: string) => bytes[hashes.indexOf(sha)]!)
  const client = {
    changes: async (since: number) => ({
      items: changes.filter((c) => c.seq > since).slice(0, 1),
      next_since: since < 2 ? 2 : 3,
      head_seq: 3,
    }),
    getBlob,
  } as unknown as EngineClient
  const report = await pull(client, fs, state, {
    expected: new ExpectedWrites(),
    dirty: new Set(),
    protectMissing: true,
    filter: { excluded: () => false },
  })
  expect(await fs.read('file.bin')).toEqual(bytes[1])
  expect(report.held.map((c) => c.seq)).toContain(3)
  expect(await state.get('file.bin')).toMatchObject({ versionId: 'a', sha: hashes[0] })
  expect(await state.getCursor()).toBeLessThan(3)
})

it('R2 streams known equal bytes from another synced local file instead of HTTP', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([9]),
    sha = await sha256(bytes)
  await fs.writeAtomic('source.bin', bytes, 1)
  await state.put({
    path: 'source.bin',
    wirePath: 'source.bin',
    fileId: 'source',
    versionId: 'source-v',
    sha,
    size: 1,
    mtime: 1,
  })
  fs.openRead = async (path) => {
    const body = await fs.read(path)
    return {
      size: body.length,
      read: async (at, length) => body.slice(at, at + length),
      assertUnchanged: async () => {},
      close: async () => {},
    }
  }
  fs.beginAtomicWrite = async (path, mtime) => {
    let data = new Uint8Array()
    return {
      id: 'stage',
      get offset() {
        return data.length
      },
      append: async (_at, part) => {
        data = new Uint8Array(part)
      },
      seal: async () => {},
      commit: async () => {
        await fs.writeAtomic(path, data, mtime)
      },
      discard: async () => {},
    }
  }
  fs.reopenStage = async () => {
    throw new Error('no restart')
  }
  fs.discardStage = async () => {}
  const getBlob = vi.fn(async () => bytes),
    openVersion = vi.fn(async () => {
      throw new Error('local bytes must be reused')
    })
  const change: ChangeItem = {
    seq: 2,
    file_id: 'target',
    version_id: 'target-v',
    path: 'target.bin',
    prev_path: null,
    op: 'create',
    sha,
    size: 1,
    mtime: 2,
    kind: 'attachment',
    actor: { kind: 'system', id: 'server', name: 'server' },
    at: '',
  }
  await applyStaged({ getBlob, openVersion } as unknown as EngineClient, fs, state, [change], {
    expected: new ExpectedWrites(),
    dirty: new Set(),
    filter: { excluded: () => false },
  })
  expect(openVersion).not.toHaveBeenCalled()
  expect(getBlob).not.toHaveBeenCalled()
  expect(await fs.read('target.bin')).toEqual(bytes)
})

for (const streaming of [false, true])
  for (const ledger of ['same-sha', 'old-sha', 'other-id'] as const)
    it(`R2 adopts equal target bytes with ${ledger} ledger and streaming=${streaming}`, async () => {
      const fs: FileSystem = new MemoryFileSystem(),
        state = new MemoryStateStore()
      const bytes = new Uint8Array([7]),
        sha = await sha256(bytes)
      await fs.writeAtomic('file.bin', bytes, 1)
      await state.put({
        path: 'file.bin',
        wirePath: 'file.bin',
        fileId: ledger === 'other-id' ? 'old-file' : 'file',
        versionId: 'old',
        sha: ledger === 'same-sha' ? sha : 'a'.repeat(64),
        size: 1,
        mtime: 1,
      })
      const getBlob = vi.fn(async () => bytes),
        openVersion = vi.fn(async () => {
          throw new Error('existing bytes must not be downloaded')
        })
      if (streaming) {
        fs.beginAtomicWrite = async () => {
          throw new Error('equal bytes must not be rewritten')
        }
        fs.reopenStage = async () => {
          throw new Error('no stage')
        }
      }
      const change: ChangeItem = {
        seq: 2,
        file_id: 'file',
        version_id: 'new',
        path: 'file.bin',
        prev_path: null,
        op: 'modify',
        sha,
        size: 1,
        mtime: 2,
        kind: 'attachment',
        actor: { kind: 'system', id: 'server', name: 'server' },
        at: '',
      }
      const report = await applyStaged(
        { getBlob, ...(streaming ? { openVersion } : {}) } as unknown as EngineClient,
        fs,
        state,
        [change],
        { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } }
      )
      expect(getBlob).not.toHaveBeenCalled()
      expect(openVersion).not.toHaveBeenCalled()
      if (ledger === 'same-sha')
        expect(await state.get('file.bin')).toMatchObject({ fileId: 'file', versionId: 'new', sha })
      else {
        expect(report.held).toHaveLength(1)
        expect(await state.get('file.bin')).toMatchObject({ versionId: 'old' })
      }
      expect(await fs.read('file.bin')).toEqual(bytes)
    })
