import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  downloadToStage,
  TransferBudget,
  MAX_CHUNK_BYTES,
  type ChunkSource,
  type AtomicStage,
} from '../../src/streaming.js'

it('streams concurrent virtual multi-GiB files with bounded live source/sink buffers', async () => {
  const size = 2 * 1024 ** 3 + 7
  const sha = '4faf054bcce4f3f1718586ceb36106e28a780ea261ba3c7fc1c8519d048f9b2f'
  const budget = new TransferBudget({ maxActiveTransfers: 2 })
  let live = 0
  let peak = 0
  let commits = 0
  const transfer = async () => {
    let buffer: Uint8Array | undefined
    let closed = false
    const source: ChunkSource = {
      size,
      async read(offset, length) {
        expect(offset + length).toBeLessThanOrEqual(size)
        expect(length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
        if (!buffer) {
          buffer = new Uint8Array(MAX_CHUNK_BYTES)
          live += buffer.byteLength
          peak = Math.max(peak, live)
        }
        // A source may reuse its leased buffer only after its sink has acknowledged it.
        return buffer.subarray(0, length)
      },
      async assertUnchanged() {},
      async close() {
        if (buffer) {
          live -= buffer.byteLength
          buffer = undefined
        }
        closed = true
      },
    }
    let offset = 0
    let sealed = false
    const hash = createHash('sha256')
    const stage: AtomicStage = {
      id: 'virtual',
      get offset() {
        return offset
      },
      async append(at, bytes) {
        expect(at).toBe(offset)
        expect(bytes.byteLength).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
        hash.update(bytes)
        offset += bytes.length
        await Promise.resolve() // Slow acknowledgement: source must wait.
      },
      async seal(expected) {
        expect(offset).toBe(expected.size)
        expect(hash.digest('hex')).toBe(expected.sha)
        sealed = true
      },
      async commit() {
        expect(sealed).toBe(true)
        commits++
      },
      async discard() {},
    }
    await downloadToStage(source, stage, { size, sha }, budget)
    expect(closed).toBe(true)
  }
  await Promise.all([transfer(), transfer(), transfer()])
  expect(commits).toBe(3)
  expect(peak).toBe(2 * MAX_CHUNK_BYTES)
  expect(live).toBe(0)
}, 30_000)
