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

it.each([false, true])(
  'keeps a known large copy bounded when local replay is unavailable, without reopening a fresh stage (port=%s)',
  async (port) => {
    const fs: FileSystem = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new Uint8Array(2 * MAX_CHUNK_BYTES).fill(13),
      sha = await sha256(bytes)
    await fs.writeAtomic('existing.bin', bytes, 1000)
    await state.put({
      path: 'existing.bin',
      wirePath: 'existing.bin',
      fileId: 'existing',
      versionId: 'base',
      sha,
      size: bytes.length,
      mtime: 1000,
    })
    fs.fingerprint = async () => ({ sha, size: bytes.length, mtime: 1000, generation: 'base' })
    fs.openRead = port
      ? async () => {
          throw new Error('Local bounded replay unavailable')
        }
      : undefined
    const reopen = vi.fn(async () => {
      throw new Error('Unexpected stage recovery')
    })
    fs.reopenStage = reopen
    const discard = vi.fn(async () => {})
    fs.beginAtomicWrite = async (path, mtime, base, beforeCreate) => {
      await beforeCreate?.('fresh-stage')
      let offset = 0
      const buffered = new Uint8Array(bytes.length)
      const stage: AtomicStage = {
        id: 'fresh-stage',
        get offset() {
          return offset
        },
        append: async (at, chunk) => {
          expect(at).toBe(offset)
          buffered.set(chunk, at)
          offset += chunk.length
        },
        seal: async (identity) => {
          expect(offset).toBe(identity.size)
          expect(await sha256(buffered)).toBe(identity.sha)
        },
        commit: async () => {
          expect(
            await fs.conditionalFile!({
              path,
              expected: base ? { ...base, mtime: base.mtime! } : null,
              effect: { kind: 'write', bytes: buffered, mtime, receipt: 'fresh-stage' },
            })
          ).toBe(true)
        },
        discard,
      }
      return stage
    }
    const read = vi.spyOn(fs, 'read'),
      openVersion = vi.fn(async () => source(bytes))
    const report = await pull(
      {
        manifest: async () => ({
          items: [
            {
              file_id: 'copy',
              version_id: 'copy-version',
              path: 'copy.bin',
              sha,
              size: bytes.length,
              mtime: 2000,
              seq: 5,
              kind: 'attachment',
            },
          ],
          head_seq: 5,
          next: null,
        }),
        changes: async () => ({ items: [], head_seq: 5, next_since: 5 }),
        openVersion,
      } as unknown as EngineClient,
      fs,
      state,
      { ...options(), prefetchBytes: 0 }
    )
    expect(read).not.toHaveBeenCalledWith('existing.bin')
    expect(openVersion).toHaveBeenCalledOnce()
    expect(reopen).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledOnce()
    expect(report.applied).toBe(1)
    expect(await sha256(await fs.read('copy.bin'))).toBe(sha)
    expect(await state.getMeta!('pull-write:copy')).toBeNull()
  }
)

it('copies a known small bounded source locally without allocating a stage or downloading', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new TextEncoder().encode('sample duplicate content'),
    sha = await sha256(bytes)
  await fs.writeAtomic('existing.md', bytes, 1000)
  await state.put({
    path: 'existing.md',
    wirePath: 'existing.md',
    fileId: 'existing',
    versionId: 'base',
    sha,
    size: bytes.length,
    mtime: 1000,
  })
  fs.openRead = async (path) => source(await fs.read(path))
  const begin = vi.fn(async () => {
    throw new Error('Unexpected staging')
  })
  fs.beginAtomicWrite = begin
  fs.reopenStage = async () => {
    throw new Error('Unexpected recovery')
  }
  const openVersion = vi.fn(async () => {
    throw new Error('Unexpected download')
  })
  const getBlob = vi.fn(async () => {
    throw new Error('Unexpected blob')
  })
  await pull(
    {
      manifest: async () => ({
        items: [
          {
            file_id: 'copy',
            version_id: 'copy-version',
            path: 'copy.md',
            sha,
            size: bytes.length,
            mtime: 2000,
            seq: 5,
            kind: 'note',
          },
        ],
        head_seq: 5,
        next: null,
      }),
      changes: async () => ({ items: [], head_seq: 5, next_since: 5 }),
      openVersion,
      getBlob,
    } as unknown as EngineClient,
    fs,
    state,
    options()
  )
  expect(begin).not.toHaveBeenCalled()
  expect(openVersion).not.toHaveBeenCalled()
  expect(getBlob).not.toHaveBeenCalled()
  expect(await fs.read('copy.md')).toEqual(bytes)
  expect(await fs.stat('existing.md')).toMatchObject({ mtime: 1000 })
})

