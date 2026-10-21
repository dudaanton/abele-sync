import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { applyStaged } from '../../src/puller.js'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'

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
        data = part
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
      await applyStaged(
        { getBlob, ...(streaming ? { openVersion } : {}) } as unknown as EngineClient,
        fs,
        state,
        [change],
        { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } }
      )
      expect(getBlob).not.toHaveBeenCalled()
      expect(openVersion).not.toHaveBeenCalled()
      expect(await state.get('file.bin')).toMatchObject({ fileId: 'file', versionId: 'new', sha })
      expect(await fs.read('file.bin')).toEqual(bytes)
    })
