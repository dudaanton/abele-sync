import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, sha256 } from '../../src/index.js'
import type { StateStore } from '../../src/state.js'
import { retainRemoval as hostRetainRemoval } from '@abele/sync-core'
import {
  captureRemoval,
  commitRemoval,
  recoverRemovals,
  retentionSnapshot,
  retainRemoval,
  retainPublishedVictim,
  acknowledgePublication,
} from '../../src/removalRetention.js'

const DAY = 86400000

it('restarts the minimum age when publication capture acknowledgement was interrupted', async () => {
  const { fs, base } = await fixture()
  const move = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (op) => {
    const applied = await move(op)
    if (applied) throw new Error('capture interrupted')
    return applied
  }
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
  try {
    await expect(
      retainPublishedVictim(fs, base.path, base.path, base, { kind: 'stage', id: 'stage' })
    ).rejects.toThrow('capture interrupted')
    fs.conditionalFile = move
    clock.mockReturnValue(8 * DAY)
    await acknowledgePublication(fs, { kind: 'stage', id: 'stage' })
    await recoverRemovals(fs, undefined, { now: () => 8 * DAY, maxBytes: 0 })
    expect(await retentionSnapshot(fs)).toHaveLength(1)
  } finally {
    clock.mockRestore()
  }
})

it('retires a decision allocation interrupted before summary creation', async () => {
  const { fs, state, base } = await fixture()
  await state.setMeta('removal-source:a', 'allocated')
  await state.setMeta(
    'removal-decision:allocated',
    JSON.stringify({ id: 'allocated', base, committed: false })
  )
  await recoverRemovals(fs, state)
  expect(await state.getMeta('removal-source:a')).toBeNull()
  expect(await captureRemoval(fs, state, base, async () => true)).toBe(true)
})

it('shares retention serialization with the host package copy of core', async () => {
  const { fs, base } = await fixture()
  await fs.writeAtomic('b.md', new Uint8Array([1]), 1)
  expect(hostRetainRemoval).not.toBe(retainRemoval)
  expect(
    await Promise.all([
      retainRemoval(fs, { path: base.path, expected: base, effect: { kind: 'remove' } }),
      hostRetainRemoval(fs, { path: 'b.md', expected: base, effect: { kind: 'remove' } }),
    ])
  ).toEqual([true, true])
  expect(await retentionSnapshot(fs)).toHaveLength(2)
})
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

it('starts the minimum age at recovery when capture acknowledgement was interrupted', async () => {
  const { fs, state, base } = await fixture()
  const move = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (op) => {
    const applied = await move(op)
    if (applied && op.effect.kind === 'move') throw new Error('capture interrupted')
    return applied
  }
  await expect(captureRemoval(fs, state, base, async () => true, 0)).rejects.toThrow(
    'capture interrupted'
  )
  fs.conditionalFile = move
  await state.transaction(async (tx) => {
    await commitRemoval(tx, base)
    await tx.delete(base.path)
  })
  await recoverRemovals(fs, state, { now: () => 8 * DAY, maxBytes: 0 })
  expect(await retentionSnapshot(fs)).toHaveLength(1)
  await recoverRemovals(fs, state, { now: () => 9 * DAY, maxBytes: 0 })
  expect(await retentionSnapshot(fs)).toEqual([])
})

it.each([NaN, Infinity, -1])(
  'rejects an invalid reclamation clock (%s) without releasing young bytes',
  async (now) => {
    const { fs, state, base } = await fixture()
    await captureRemoval(fs, state, base, async () => true, 0)
    await state.transaction(async (tx) => {
      await commitRemoval(tx, base)
      await tx.delete(base.path)
    })
    const before = await retentionSnapshot(fs)
    await expect(recoverRemovals(fs, state, { now: () => now, maxBytes: 0 })).rejects.toMatchObject(
      { code: 'protocol' }
    )
    expect(await retentionSnapshot(fs)).toEqual(before)
    expect(await fs.read(before[0]!.victim)).toEqual(new Uint8Array([1]))
  }
)

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

it('acknowledges metadata-less ownership across wrappers without treating identity as a vault key', async () => {
  const { fs, state, base } = await fixture()
  const hide = (state: StateStore): StateStore =>
    new Proxy(state, {
      get: (target, key) => {
        if (['getMeta', 'setMeta', 'metadataKeys'].includes(String(key))) return undefined
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  const wrap = () =>
    new Proxy(fs, {
      get: (target, key) => {
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  expect(await captureRemoval(wrap(), hide(state), base, async () => true, 0)).toBe(true)
  await state.transaction(async (tx) => {
    await commitRemoval(hide(tx), base, wrap())
    await tx.delete(base.path)
  })
  await recoverRemovals(wrap(), hide(state), { now: () => 1 })
  expect(await fs.stat(base.path)).toBeNull()
  expect((await retentionSnapshot(fs))[0]?.phase).toBe('committed')
})
