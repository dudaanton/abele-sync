import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, sha256 } from '../../src/index.js'
import {
  captureRemoval,
  commitRemoval,
  recoverRemovals,
  retentionSnapshot,
} from '../../src/removalRetention.js'

const DAY = 86400000
async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1])
  await fs.writeAtomic('a.md', bytes, 1)
  const base = {
    path: 'a.md',
    wirePath: 'a.md',
    fileId: 'a',
    versionId: 'v',
    size: 1,
    mtime: 1,
    sha: await sha256(bytes),
  }
  await state.put(base)
  return { fs, state, base, bytes }
}

it('restores a capture when an equal-byte ledger replacement prevents decision commit', async () => {
  const { fs, state, base, bytes } = await fixture()
  expect(await captureRemoval(fs, state, base, async () => true, 0)).toBe(true)
  await state.put({ ...base, fileId: 'replacement' })
  await recoverRemovals(fs, state, { now: () => DAY * 8 })
  expect(await fs.read(base.path)).toEqual(bytes)
  expect((await state.get(base.path))?.fileId).toBe('replacement')
  expect(await retentionSnapshot(fs)).toEqual([])
})

it('keeps committed bytes for 24 hours even over quota, then reclaims only eligible bytes', async () => {
  const { fs, state, base } = await fixture()
  expect(await captureRemoval(fs, state, base, async () => true, 0)).toBe(true)
  await state.transaction(async (tx) => {
    await commitRemoval(tx, base)
    await tx.delete(base.path)
  })
  const log = vi.fn()
  await recoverRemovals(fs, state, { now: () => DAY - 1, maxBytes: 0, log })
  expect(await retentionSnapshot(fs)).toHaveLength(1)
  expect(log).toHaveBeenCalled()
  await recoverRemovals(fs, state, { now: () => DAY, maxBytes: 0 })
  expect(await retentionSnapshot(fs)).toEqual([])
  expect(await fs.stat(base.path)).toBeNull()
})

it.each([false, true])(
  'publishes late unique bytes without overwriting an occupant (%s)',
  async (occupied) => {
    const { fs, state, base, bytes } = await fixture()
    await captureRemoval(fs, state, base, async () => true, 0)
    await state.transaction(async (tx) => {
      await commitRemoval(tx, base)
      await tx.delete(base.path)
    })
    const [row] = await retentionSnapshot(fs)
    await fs.writeAtomic(row!.victim, new Uint8Array([2]), 1)
    if (occupied) await fs.writeAtomic(base.path, bytes, 1)
    await recoverRemovals(fs, state, { now: () => DAY * 8 })
    expect(await fs.read(occupied ? `${base.path}.sync-conflict-${row!.id}` : base.path)).toEqual(
      new Uint8Array([2])
    )
    if (occupied) expect(await fs.read(base.path)).toEqual(bytes)
    expect(await retentionSnapshot(fs)).toEqual([])
  }
)

it('retires compatibility captures without requiring object identity', async () => {
  const { fs, state, base } = await fixture()
  Object.defineProperty(fs, 'fileIdentity', { value: undefined })
  Object.defineProperty(fs, 'conditionalOwnership', { value: undefined })
  for (let i = 0; i < 4; i++) {
    await fs.writeAtomic(base.path, new Uint8Array([1]), 1)
    await state.put(base)
    expect(await captureRemoval(fs, state, base, async () => true, 0)).toBe(true)
    await state.transaction(async (tx) => {
      await commitRemoval(tx, base)
      await tx.delete(base.path)
    })
    await recoverRemovals(fs, state, { now: () => DAY * 8 })
  }
  expect(await retentionSnapshot(fs)).toEqual([])
  expect([...fs.snapshot().keys()].filter((path) => path.endsWith('/victim'))).toEqual([])
})

it('resumes a durable handover after metadata acknowledgement fails', async () => {
  const { fs, state, base } = await fixture()
  await captureRemoval(fs, state, base, async () => true, 0)
  await state.transaction(async (tx) => {
    await commitRemoval(tx, base)
    await tx.delete(base.path)
  })
  const transaction = state.transaction.bind(state)
  state.transaction = async () => {
    throw new Error('ack failed')
  }
  await expect(recoverRemovals(fs, state, { now: () => 1 })).rejects.toThrow('ack failed')
  expect((await retentionSnapshot(fs))[0]?.phase).toBe('committed')
  state.transaction = transaction
  await recoverRemovals(fs, state, { now: () => 1 })
  expect((await retentionSnapshot(fs))[0]?.decision).toBeUndefined()
  expect(await state.metadataKeys('removal-decision:')).toEqual([])
})

it('reads only the summary for young handed-over captures on startup', async () => {
  const { fs, state, base } = await fixture()
  await captureRemoval(fs, state, base, async () => true, 0)
  await state.transaction(async (tx) => {
    await commitRemoval(tx, base)
    await tx.delete(base.path)
  })
  await recoverRemovals(fs, state, { now: () => 1 })
  const read = vi.spyOn(fs, 'read'),
    stat = vi.spyOn(fs, 'stat'),
    list = vi.spyOn(fs, 'list')
  await recoverRemovals(fs, state, { now: () => 2 })
  expect(read.mock.calls).toEqual([['.abele-sync/retained-removals/summary.json']])
  expect(stat.mock.calls).toEqual([['.abele-sync/retained-removals/summary.json']])
  expect(list).not.toHaveBeenCalled()
})

it('serializes summary ownership through distinct wrappers of the same host', async () => {
  const { fs, state, base } = await fixture()
  const other = { ...base, path: 'b.md', wirePath: 'b.md', fileId: 'b' }
  await fs.writeAtomic(other.path, new Uint8Array([1]), 1)
  await state.put(other)
  const wrap = () =>
    new Proxy(fs, {
      get: (target, key) => {
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  expect(
    await Promise.all([
      captureRemoval(wrap(), state, base, async () => true, 0),
      captureRemoval(wrap(), state, other, async () => true, 0),
    ])
  ).toEqual([true, true])
  expect(await retentionSnapshot(fs)).toHaveLength(2)
})
