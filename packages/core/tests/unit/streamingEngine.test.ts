import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import {
  applyStaged,
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  TransferBudget,
  MAX_CHUNK_BYTES,
  type EngineClient,
  type FileSystem,
  type ContentIdentity,
} from '../../src/index.js'

it('normal concurrent hydration of multi-GiB virtual files never assembles file bodies', async () => {
  const size = 2 * 1024 ** 3 + 7
  const zeros = new Uint8Array(MAX_CHUNK_BYTES)
  const hash = createHash('sha256')
  for (let at = 0; at < size; at += MAX_CHUNK_BYTES)
    hash.update(zeros.subarray(0, Math.min(MAX_CHUNK_BYTES, size - at)))
  const identity = { size, sha: hash.digest('hex') }
  let live = 0,
    peak = 0,
    closed = 0
  const budget = new TransferBudget()
  const hydrate = async (id: string) => {
    const state = new MemoryStateStore()
    const fs: FileSystem = new MemoryFileSystem()
    let published = false
    fs.read = async () => {
      throw new Error('whole-file read forbidden')
    }
    fs.writeAtomic = async () => {
      throw new Error('whole-file write forbidden')
    }
    fs.stat = async (path) => (published ? { path, size, mtime: 1000 } : null)
    fs.fingerprint = async () => ({ ...identity, mtime: 1000, generation: 'virtual' })
    fs.reopenStage = async () => {
      throw new Error('not a restart')
    }
    fs.beginAtomicWrite = async () => {
      const hash = createHash('sha256')
      let offset = 0
      return {
        id,
        get offset() {
          return offset
        },
        async append(at: number, bytes: Uint8Array) {
          expect(at).toBe(offset)
          expect(bytes.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
          expect(bytes.buffer.byteLength).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
          hash.update(bytes)
          await Promise.resolve()
          live -= bytes.length
          offset += bytes.length
        },
        async seal(expected: ContentIdentity) {
          expect(offset).toBe(expected.size)
          expect(hash.digest('hex')).toBe(expected.sha)
        },
        async commit() {
          published = true
        },
        async discard() {},
      }
    }
    const client = {
      async getBlob() {
        throw new Error('whole response forbidden')
      },
      async openVersion() {
        return {
          size,
          async read(at: number, length: number) {
            expect(length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
            expect(at + length).toBeLessThanOrEqual(size)
            live += length
            peak = Math.max(peak, live)
            return new Uint8Array(length)
          },
          async assertUnchanged() {},
          async close() {
            closed++
          },
        }
      },
    } as unknown as EngineClient
    const change: ChangeItem = {
      seq: 1,
      file_id: id,
      version_id: 'immutable',
      path: 'large.bin',
      op: 'create',
      prev_path: null,
      ...identity,
      mtime: 1000,
      kind: 'attachment',
      actor: { kind: 'system', id: 'test', name: 'test' },
      at: '',
    }
    const result = await applyStaged(client, fs, state, [change], {
      filter: { excluded: () => false },
      dirty: new Set(),
      expected: new ExpectedWrites(),
      transferBudget: budget,
    })
    expect(result.applied).toBe(1)
    expect((await state.byFileId(id))?.sha).toBe(identity.sha)
  }
  await Promise.all(['a', 'b', 'c'].map(hydrate))
  expect(peak).toBeLessThanOrEqual(2 * MAX_CHUNK_BYTES)
  expect(live).toBe(0)
  expect(closed).toBe(3)
}, 60_000)
