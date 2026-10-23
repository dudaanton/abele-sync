import { expect, it, vi } from 'vitest'
import { MemoryStreamingFS } from '../sim/streamingMemoryFs.js'
import { SimScheduler } from '../sim/scheduler.js'
import {
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  MAX_CHUNK_BYTES,
  pull,
  sha256,
  type AtomicStage,
  type ChunkSource,
  type EngineClient,
  type FileSystem,
} from '../../src/index.js'

const options = () => ({
  dirty: new Set<string>(),
  expected: new ExpectedWrites(),
  filter: { excluded: () => false },
})
const source = (bytes: Uint8Array): ChunkSource => ({
  size: bytes.length,
  read: async (at, length) => {
    expect(length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
    return bytes.slice(at, at + length)
  },
  assertUnchanged: async () => {},
  close: async () => {},
})

it('applies a feed page before requesting the next page, then adopts an equal move target', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new TextEncoder().encode('sample content'),
    sha = await sha256(bytes)
  await fs.writeAtomic('b.md', bytes, 1000)
  await state.setCursor(1)
  const item = {
    file_id: 'sample-file',
    sha,
    size: bytes.length,
    mtime: 1000,
    kind: 'note' as const,
    at: '',
    actor: { kind: 'system' as const, id: 'sample', name: 'Sample' },
  }
  const getBlob = vi.fn(async () => bytes)
  const changes = vi.fn(async (since: number) => {
    if (since === 1)
      return {
        items: [
          {
            ...item,
            seq: 2,
            version_id: 'created',
            op: 'create' as const,
            path: 'a.md',
            prev_path: null,
          },
        ],
        head_seq: 3,
        next_since: 2,
      }
    expect(since).toBe(2)
    expect(await fs.read('a.md')).toEqual(bytes)
    expect(await state.byFileId(item.file_id)).toMatchObject({ versionId: 'created' })
    getBlob.mockImplementation(async () => {
      throw new Error('Content offline')
    })
    return {
      items: [
        {
          ...item,
          seq: 3,
          version_id: 'moved',
          op: 'move' as const,
          path: 'b.md',
          prev_path: 'a.md',
        },
      ],
      head_seq: 3,
      next_since: 3,
    }
  })
  const report = await pull({ changes, getBlob } as unknown as EngineClient, fs, state, options())
  expect(changes.mock.calls.map(([since]) => since)).toEqual([1, 2])
  expect(getBlob).toHaveBeenCalledOnce()
  expect(report.held).toEqual([])
  expect(await fs.read('b.md')).toEqual(bytes)
  expect(await fs.stat('a.md')).toBeNull()
  expect(await state.byFileId(item.file_id)).toMatchObject({
    path: 'b.md',
    versionId: 'moved',
    sha,
  })
  expect(await state.getCursor()).toBe(3)
})

