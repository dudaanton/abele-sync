import { expect, it } from 'vitest'
import { MemoryStateStore, type StateStore } from '../../src/state.js'
import { placementState, placeWave } from '../../src/placement.js'
import { transact } from '../../src/stateTransaction.js'
import { legacyState } from '../helpers/legacyState.js'
import type { ChangeItem } from '@abele/sync-protocol'
import { concurrentPlacement, queuedScopedState } from '../helpers/concurrentPlacement.js'

async function bounded<T>(task: T | Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('placement deadlocked')), 500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

it('D-203 passes an unqueued capability to a callback without a transaction handle', async () => {
  let writes = 0
  const root = {
    transaction: async (fn: () => Promise<void>) => fn(),
    setMeta: async () => {
      writes++
    },
  } as unknown as StateStore
  await bounded(
    transact(placementState(root), async (tx) => {
      await tx.setMeta!('test', 'value')
    })
  )
  expect(writes).toBe(1)
})

// BUG: reproduced with Zod 3: private retirement keeps an intent inside the
// outer transaction, violating concurrentPlacement's existing cleanup guarantee.
it.fails('BUG: supports concurrent placement inside an existing scoped capability', async () => {
  const state = new MemoryStateStore()
  await bounded(state.transaction((tx) => concurrentPlacement(tx)))
  expect(await state.byFileId('placement-5')).toMatchObject({ versionId: 'v1' })
})

it.each(['scoped', 'unadvertised', 'legacy', 'root', 'plugin'] as const)(
  'D-203 nested mutations, root ordering, rollback and cancellation drain (%s)',
  async (shape) => {
    const disk = new MemoryStateStore()
    const store =
      shape === 'legacy' || shape === 'root'
        ? legacyState(disk, shape === 'root')
        : shape === 'plugin'
          ? queuedScopedState(disk)
          : disk
    if (shape === 'unadvertised')
      Object.defineProperty(store, 'transactionScoped', { value: false })
    const state = placementState(store)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const stop = new AbortController()
    const task = placeWave([{} as ChangeItem], stop.signal, async () => {
      await transact(state, async (tx) => {
        await tx.setMeta!('first', 'yes')
        await transact(tx, async (nested) => {
          await nested.setMeta!('nested', 'yes')
        })
        entered()
        await gate
      })
    })
    const outcome = task.catch((error) => error)
    try {
      await bounded(started)
      const queued = state.setMeta!('later', 'yes')
      expect(await disk.getMeta('later')).toBeNull()
      stop.abort()
      release()
      expect(await bounded(outcome)).toMatchObject({ message: 'sync stopped' })
      await bounded(queued)
      expect(await disk.getMeta('nested')).toBe('yes')
      expect(await disk.getMeta('later')).toBe('yes')
      await expect(
        bounded(
          transact(state, async (tx) => {
            await tx.setMeta!('rollback', 'no')
            throw new Error('rollback')
          })
        )
      ).rejects.toThrow('rollback')
      expect(await disk.getMeta('rollback')).toBeNull()
      await bounded(state.setMeta!('after-failure', 'yes'))
      await bounded(concurrentPlacement(store))
    } finally {
      release()
    }
  }
)

it.each([false, true])(
  'still rejects an invalid advertised scoped store (root=%s)',
  async (rootHandle) => {
    const state = {
      transactionScoped: true,
      transaction: async (work: (tx?: StateStore) => Promise<void>) =>
        work(rootHandle ? (state as StateStore) : undefined),
    } as StateStore
    await expect(bounded(transact(placementState(state), async () => {}))).rejects.toMatchObject({
      code: 'protocol',
    })
  }
)
