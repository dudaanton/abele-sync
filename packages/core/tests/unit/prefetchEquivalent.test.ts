import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites, sha256 } from '../../src/index.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'

it('holds normalization collisions instead of fetching or failing during prefetch resolution', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes),
    path = 'Café.md'
  await fs.writeAtomic(path, bytes, 1)
  await fs.writeAtomic(path.normalize('NFD'), bytes, 1)
  const getBlob = vi.fn(async () => {
    throw new Error('collision must not fetch')
  })
  const client = {
    manifest: async () => ({
      items: [
        { seq: 1, file_id: 'file', version_id: 'v1', path, sha, size: 1, mtime: 1, kind: 'note' },
      ],
      next: null,
      head_seq: 1,
    }),
    changes: async () => ({ items: [], head_seq: 1, next_since: 1 }),
    getBlob,
  } as unknown as EngineClient
  const result = await pull(client, fs, state, {
    dirty: new Set(),
    expected: new ExpectedWrites(),
    filter: { excluded: () => false },
  })
  expect(result.held).toHaveLength(1)
  expect(result.cursor).toBe(0)
  expect(getBlob).not.toHaveBeenCalled()
  expect(await state.byFileId('file')).toBeNull()
})

it.each([false, true])(
  'D-111 adopts untracked NFD content without a GET (download would fail: %s)',
  async (fail) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new TextEncoder().encode('already here'),
      sha = await sha256(bytes)
    const path = 'Café.md',
      physical = path.normalize('NFD')
    await fs.writeAtomic(physical, bytes, 1)
    const getBlob = vi.fn(async () => {
      if (fail) throw new Error('offline')
      return bytes
    })
    const client = {
      manifest: async () => ({
        items: [
          {
            seq: 1,
            file_id: 'file',
            version_id: 'v1',
            path,
            sha,
            size: bytes.length,
            mtime: 1,
            kind: 'note',
          },
        ],
        next: null,
        head_seq: 1,
      }),
      changes: async () => ({ items: [], head_seq: 1, next_since: 1 }),
      getBlob,
    } as unknown as EngineClient
    const report = await pull(client, fs, state, {
      dirty: new Set(),
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    })
    expect(getBlob).not.toHaveBeenCalled()
    expect(report.cursor).toBe(1)
    expect(report.held).toEqual([])
    expect(await state.get(physical)).toMatchObject({ fileId: 'file', versionId: 'v1', sha })
    expect([...fs.snapshot().keys()]).toEqual([physical])
  }
)

it.each([true, false])(
  'D-111 rechecks equivalent content after a failed request (local match: %s)',
  async (matches) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new TextEncoder().encode('arrived locally'),
      sha = await sha256(bytes)
    const path = 'Café.md',
      physical = path.normalize('NFD'),
      failure = new Error('content request failed')
    const getBlob = vi.fn(async () => {
      await fs.writeAtomic(physical, matches ? bytes : new Uint8Array([9]), 1)
      throw failure
    })
    const client = {
      manifest: async () => ({
        items: [
          {
            seq: 1,
            file_id: 'file',
            version_id: 'v1',
            path,
            sha,
            size: bytes.length,
            mtime: 1,
            kind: 'note',
          },
        ],
        next: null,
        head_seq: 1,
      }),
      changes: async () => ({ items: [], head_seq: 1, next_since: 1 }),
      getBlob,
    } as unknown as EngineClient
    const running = pull(client, fs, state, {
      dirty: new Set(),
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    })
    if (matches) {
      expect((await running).cursor).toBe(1)
      expect(await state.get(physical)).toMatchObject({ versionId: 'v1', sha })
    } else {
      await expect(running).rejects.toBe(failure)
      expect(await state.getCursor()).toBe(0)
      expect(await state.get(physical)).toBeNull()
    }
    expect(getBlob).toHaveBeenCalledTimes(1)
  }
)
