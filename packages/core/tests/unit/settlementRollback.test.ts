import { expect, it } from 'vitest'
import { MemoryStateStore } from '../../src/state.js'
import { PullHolds } from '../../src/pullHolds.js'
import { transact } from '../../src/stateTransaction.js'
import { commitAppliedSettlement } from '../../src/settlement.js'
import { change } from './holdFixture.js'

it('D-214 keeps nested persistence dirty until a raw outer host transaction commits', async () => {
  const state = new MemoryStateStore()
  const holds = new PullHolds(state)
  await holds.load()
  const item = await change(0)
  holds.put({ change: item, base: null, firstSeq: item.seq })
  await expect(
    state.transaction(async (outer) => {
      await transact(outer, (tx) => holds.persist(10, true, tx))
      expect(holds.dirty).toBe(true)
      throw new Error('rollback')
    })
  ).rejects.toThrow('rollback')
  expect(holds.dirty).toBe(true)
  expect(await state.getMeta('pull-held-progress')).toBeNull()
  await state.transaction(async (outer) => {
    await transact(outer, (tx) => holds.persist(10, true, tx))
    expect(holds.dirty).toBe(true)
  })
  expect(holds.dirty).toBe(false)
  const reopened = new PullHolds(state)
  await reopened.load()
  expect(reopened.files.get(item.file_id)).toEqual(item)
})

it('retains the unresolved patch when publication fails after hold persistence', async () => {
  const state = new MemoryStateStore()
  const holds = new PullHolds(state)
  await holds.load()
  const item = await change(0)
  holds.put({ change: item, base: null, firstSeq: item.seq })
  await expect(
    transact(state, async (tx) => {
      await holds.persist(10, true, tx)
      throw new Error('publication failed')
    })
  ).rejects.toThrow('publication failed')
  expect(await state.getMeta('pull-held-progress')).toBeNull()
  expect(holds.dirty).toBe(true)
  await transact(state, async (tx) => {
    await holds.persist(10, true, tx)
    await tx.setCursor(0)
  })
  const reopened = new PullHolds(state)
  await reopened.load()
  expect(reopened.files.get(item.file_id)).toEqual(item)
  expect(reopened.earliest()).toBe(1)
  expect(holds.dirty).toBe(false)
})

it('does not acknowledge a nested savepoint until the outer host commits', async () => {
  const state = new MemoryStateStore()
  const holds = new PullHolds(state)
  await holds.load()
  const item = await change(0)
  holds.put({ change: item, base: null, firstSeq: item.seq })
  await expect(
    transact(state, async (outer) => {
      await transact(outer, (tx) => holds.persist(10, true, tx))
      expect(holds.dirty).toBe(true)
      throw new Error('outer rollback')
    })
  ).rejects.toThrow('outer rollback')
  expect(holds.dirty).toBe(true)
  expect(await state.getMeta('pull-held-progress')).toBeNull()
  await transact(state, (outer) => transact(outer, (tx) => holds.persist(10, true, tx)))
  expect(holds.dirty).toBe(false)
})

it('preserves edits made after the persisted revision', async () => {
  const state = new MemoryStateStore()
  const holds = new PullHolds(state)
  await holds.load()
  const item = await change(0)
  holds.put({ change: item, base: null, firstSeq: item.seq })
  await transact(state, async (tx) => {
    await holds.persist(10, true, tx)
    holds.setBase(item.file_id, 'new base')
  })
  expect(holds.dirty).toBe(true)
  await transact(state, (tx) => holds.persist(10, true, tx))
  expect(holds.dirty).toBe(false)
  const reopened = new PullHolds(state)
  await reopened.load()
  expect(reopened.records.get(item.file_id)?.base).toBe('new base')
})

it('keeps the patch dirty when the host rejects commit after the callback returns', async () => {
  const state = new MemoryStateStore()
  const holds = new PullHolds(state)
  await holds.load()
  const item = await change(0)
  holds.put({ change: item, base: null, firstSeq: 1 })
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = transact(state, async (tx) => {
    await holds.persist(10, true, tx)
    entered()
    await gate
  })
  const rejected = expect(pending).rejects.toThrow('state changed outside the transaction')
  await ready
  await state.setMeta('unrelated', 'survives')
  release()
  await rejected
  expect(await state.getMeta('unrelated')).toBe('survives')
  expect(await state.getMeta('pull-held-progress')).toBeNull()
  expect(holds.dirty).toBe(true)
  await transact(state, (tx) => holds.persist(10, true, tx))
  expect(holds.dirty).toBe(false)
})

it.each([
  [40, null, 40],
  [40, 12, 11],
  [40, 50, 40],
  [40, 1, 0],
] as const)(
  'settles reached=%s with first unresolved=%s at %s',
  async (reached, first, expected) => {
    const state = new MemoryStateStore()
    const cursor = await commitAppliedSettlement(
      state,
      () => ({ reached, firstUnresolved: first }),
      async (tx) => {
        await tx.setMeta!('unresolved', JSON.stringify(first))
      }
    )
    expect(cursor).toBe(expected)
    expect(await state.getCursor()).toBe(expected)
    expect(await state.getMeta('unresolved')).toBe(JSON.stringify(first))
  }
)

it('keeps persistence linear for 33,000 unresolved entries and their retirement', async () => {
  const state = new MemoryStateStore()
  const holds = new PullHolds(state)
  await holds.load()
  const item = await change(0)
  const count = 33_000
  let writes = 0
  let bytes = 0
  const persist = () =>
    commitAppliedSettlement(
      state,
      () => ({ reached: count, firstUnresolved: holds.earliest() }),
      async (tx) => {
        const setMeta = tx.setMeta!.bind(tx)
        tx.setMeta = async (key, value) => {
          writes++
          bytes += value?.length ?? 0
          if (writes > count * 8 || bytes > count * 3000) throw new Error('nonlinear persistence')
          await setMeta(key, value)
        }
        await holds.persist(count, true, tx)
      }
    )
  for (let n = 0; n < count; n++) {
    const change = { ...item, file_id: `f${n}`, path: `${n}.bin`, seq: n + 1 }
    holds.put({ change, firstSeq: n + 1, base: null })
    await persist()
  }
  expect(await state.getCursor()).toBe(0)
  // Retire in reverse order while the oldest obligation pins the frontier.
  for (let n = count - 1; n >= 0; n--) {
    holds.resolve({ ...item, file_id: `f${n}`, seq: n + 1 })
    await persist()
  }
  expect(await state.getCursor()).toBe(count)
  expect(state.metadataKeys('pull-held:')).toEqual([])
  expect(writes).toBeGreaterThan(count)
  expect(writes).toBeLessThanOrEqual(count * 8)
  expect(bytes).toBeLessThanOrEqual(count * 3000)
}, 30_000)
