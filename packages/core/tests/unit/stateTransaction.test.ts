import { expect, it } from 'vitest'
import { MemoryStateStore, type StateStore } from '../../src/state.js'
import { transact } from '../../src/stateTransaction.js'
import { rollbackIsolation } from '../helpers/stateTransactionContract.js'

it('isolates unrelated writes from a suspended memory transaction rollback', async () => {
  await rollbackIsolation(new MemoryStateStore())
})

it('keeps tentative writes private, refuses stale publication and expires the capability', async () => {
  const store = new MemoryStateStore()
  let expired!: StateStore
  await expect(
    store.transaction(async (tx) => {
      expired = tx
      await tx.setCursor(9)
      await tx.setMeta!('private', 'tentative')
      expect(await tx.getCursor()).toBe(9)
      expect(await store.getCursor()).toBe(0)
      expect(await store.getMeta('private')).toBeNull()
      await store.setMeta('outside', 'committed')
    })
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(await store.getCursor()).toBe(0)
  expect(await store.getMeta('private')).toBeNull()
  expect(await store.getMeta('outside')).toBe('committed')
  await expect(expired.setCursor(20)).rejects.toThrow('expired')
})

it('supports exclusive-access legacy stores, including nested engine work', async () => {
  const root = new MemoryStateStore()
  let expired!: StateStore
  let current: StateStore = root
  const legacy = new Proxy({} as StateStore, {
    get(_target, key) {
      if (key === 'transactionScoped') return undefined
      if (key === 'transaction')
        return <T>(work: (tx?: StateStore) => Promise<T>) =>
          root.transaction(async (tx) => {
            current = tx
            try {
              return await work()
            } finally {
              current = root
            }
          })
      const value = Reflect.get(current, key)
      return typeof value === 'function' ? value.bind(current) : value
    },
  })
  await transact(legacy, async (tx) => {
    expired = tx
    await tx.setCursor(10)
    await transact(tx, async (nested) => {
      expect(await nested.getCursor()).toBe(10)
      await nested.setCursor(20)
    })
  })
  expect(await root.getCursor()).toBe(20)
  await expect(expired.setCursor(30)).rejects.toThrow('expired')
  expect(await root.getCursor()).toBe(20)
})

it('refuses a falsely advertised scoped store instead of silently using its root', async () => {
  const store = new MemoryStateStore()
  store.transaction = async (work) => work(store)
  await expect(transact(store, (tx) => tx.setCursor(10))).rejects.toMatchObject({
    code: 'protocol',
  })
  expect(await store.getCursor()).toBe(0)
})
