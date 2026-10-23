import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import {
  applyStaged,
  recoverPendingPullWrites,
  MemoryFileSystem,
  MemoryStateStore,
  ExpectedWrites,
  sha256,
  type EngineClient,
  type FileSystem,
  type AtomicStage,
} from '../../src/index.js'

it('resumes a case-only rename when both names stat the same file after a crash', async () => {
  const fs: FileSystem = new MemoryFileSystem({ caseInsensitive: true })
  const read = fs.read.bind(fs)
  await fs.writeAtomic('Name.bin', new Uint8Array([1]), 1000)
  fs.fingerprint = async (path) => ({
    ...(await fs.stat(path))!,
    sha: await sha256(await read(path)),
    generation: 'host',
  })
  const state = new MemoryStateStore()
  await state.put({
    path: 'Name.bin',
    wirePath: 'Name.bin',
    fileId: 'f',
    versionId: 'old',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1000,
  })
  const bytes = new Uint8Array([2, 3])
  const identity = { size: bytes.length, sha: await sha256(bytes) }
  let stage!: AtomicStage,
    offset = 0
  const received: number[] = []
  fs.beginAtomicWrite = async (path, mtime) =>
    (stage = {
      id: 'opaque-host-stage',
      get offset() {
        return offset
      },
      async append(at, chunk) {
        expect(at).toBe(offset)
        received.push(...chunk)
        offset += chunk.length
      },
      async seal(expected) {
        expect(await sha256(new Uint8Array(received))).toBe(expected.sha)
        expect(offset).toBe(expected.size)
      },
      async commit() {
        await fs.writeAtomic(path, new Uint8Array(received), mtime)
      },
      async discard() {},
    })
  fs.reopenStage = async (id) => {
    expect(id).toBe(stage.id)
    return stage
  }
  let crash = true
  const client = {
    async getBlob() {
      throw new Error('whole response forbidden')
    },
    async openVersion() {
      if (crash) throw new Error('crash')
      return {
        size: bytes.length,
        async read(at: number, length: number) {
          return bytes.slice(at, at + length)
        },
        async assertUnchanged() {},
        async close() {},
      }
    },
  } as unknown as EngineClient
  const change: ChangeItem = {
    seq: 1,
    file_id: 'f',
    version_id: 'new',
    path: 'name.bin',
    prev_path: 'Name.bin',
    op: 'move',
    ...identity,
    mtime: 2000,
    kind: 'attachment',
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  await expect(
    applyStaged(client, fs, state, [change], {
      filter: { excluded: () => false },
      dirty: new Set(),
      expected: new ExpectedWrites(),
      prefetchBytes: 0,
    })
  ).rejects.toThrow('crash')
  crash = false
  await recoverPendingPullWrites(fs, state, ['f'], client)
  expect(await fs.read('name.bin')).toEqual(bytes)
  expect((await state.byFileId('f'))?.path).toBe('name.bin')
  expect(await state.getMeta('pull-write:f')).toBeNull()
})
