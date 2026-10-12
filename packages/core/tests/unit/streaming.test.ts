import { expect, it } from 'vitest'
import {
  chunks,
  fingerprintSource,
  TransferBudget,
  MAX_CHUNK_BYTES,
  downloadToStage,
  forwardVersion,
} from '../../src/streaming.js'
import type { ChunkSource } from '../../src/streaming.js'

it('transfers concurrent virtual multi-GiB files with at most two live 1 MiB chunks', async () => {
  const size = 3 * 1024 ** 3
  const budget = new TransferBudget()
  let live = 0,
    peak = 0,
    closed = 0,
    published = 0
  const makeSource = (): ChunkSource => ({
    size,
    async read(at, length) {
      expect(at + length).toBeLessThanOrEqual(size)
      expect(length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
      live += length
      peak = Math.max(peak, live)
      return new Uint8Array(length)
    },
    async assertUnchanged() {},
    async close() {
      closed++
    },
  })
  const expected = { size, sha: 'a'.repeat(64) }
  const makeStage = () => ({
    id: 'virtual',
    offset: 0,
    async append(at: number, bytes: Uint8Array) {
      expect(at).toBe(this.offset)
      expect(bytes.length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
      await Promise.resolve()
      this.offset += bytes.length
      live -= bytes.length
    },
    async seal(identity: typeof expected) {
      expect(identity).toEqual(expected)
      expect(this.offset).toBe(size)
    },
    async commit() {
      published++
    },
    async discard() {},
  })
  await Promise.all(
    Array.from({ length: 3 }, () => downloadToStage(makeSource(), makeStage(), expected, budget))
  )
  expect(peak).toBeLessThanOrEqual(2 * MAX_CHUNK_BYTES)
  expect(live).toBe(0)
  expect(closed).toBe(3)
  expect(published).toBe(3)
  await forwardVersion(
    { openVersion: async () => makeSource() },
    {
      async putBlobSource(identity, source, signal, cap) {
        expect(identity).toEqual(expected)
        expect(cap).toBe(MAX_CHUNK_BYTES)
        for await (const bytes of chunks(source, cap, signal)) live -= bytes.length
      },
    },
    'file',
    'version',
    expected,
    budget
  )
  expect(live).toBe(0)
  expect(closed).toBe(4)
}, 30_000)

it('reads bounded chunks without read-ahead and closes on early return', async () => {
  let reads = 0
  let closed = false
  const source: ChunkSource = {
    size: 4 * 1024 ** 3,
    async read(_offset, length) {
      reads++
      expect(length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
      return new Uint8Array(length)
    },
    async assertUnchanged() {},
    async close() {
      closed = true
    },
  }
  for await (const chunk of chunks(source)) {
    expect(chunk.length).toBe(MAX_CHUNK_BYTES)
    break
  }
  expect(reads).toBe(1)
  expect(closed).toBe(true)
})

it('hashes empty sources and closes on malformed reads or cancellation', async () => {
  let closed = 0
  const source: ChunkSource = {
    size: 0,
    async read() {
      return new Uint8Array(2)
    },
    async assertUnchanged() {},
    async close() {
      closed++
    },
  }
  expect((await fingerprintSource(source)).sha).toBe(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  )
  await expect(fingerprintSource({ ...source, size: 3 })).rejects.toThrow('length')
  const controller = new AbortController()
  controller.abort()
  await expect(fingerprintSource(source, undefined, controller.signal)).rejects.toThrow()
  expect(closed).toBe(3)
})

it('shares slots, cancels queued work and releases after failure', async () => {
  const budget = new TransferBudget({ maxActiveTransfers: 1 })
  let release!: () => void
  const first = budget.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  await Promise.resolve()
  const controller = new AbortController()
  const queued = budget.run(async () => {
    throw new Error('must not run')
  }, controller.signal)
  controller.abort()
  await expect(queued).rejects.toThrow()
  release()
  await first
  await expect(
    budget.run(async () => {
      throw new Error('failure')
    })
  ).rejects.toThrow('failure')
  expect(await budget.run(async () => 7)).toBe(7)
})

it('closes a download source cancelled while waiting for the shared budget', async () => {
  const budget = new TransferBudget({ maxActiveTransfers: 1 })
  let release!: () => void
  const occupying = budget.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  let closed = false
  const source: ChunkSource = {
    size: 0,
    async read() {
      throw new Error('must not read')
    },
    async assertUnchanged() {},
    async close() {
      closed = true
    },
  }
  const stage = {
    id: 's',
    offset: 0,
    async append() {},
    async seal() {},
    async commit() {},
    async discard() {},
  }
  const controller = new AbortController()
  const pending = downloadToStage(source, stage, { size: 0, sha: '' }, budget, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow()
  release()
  await occupying
  expect(closed).toBe(true)
})
