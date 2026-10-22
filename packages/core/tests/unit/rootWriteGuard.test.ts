import { expect, it } from 'vitest'
import { MemoryStateStore } from '../../src/state.js'
import { guardRootWrites, takeRootWriteViolations } from '../helpers/rootWriteGuard.js'

guardRootWrites(MemoryStateStore.prototype)

for (const delay of [false, true])
  it(`detects a helper's captured-root write, after await: ${delay}`, async () => {
    const state = new MemoryStateStore()
    const tally = async () => {
      if (delay) await Promise.resolve()
      await state.setMeta('count', '1')
    }
    await expect(
      state.transaction(async (tx) => {
        await tx.setCursor(10)
        await tally()
      })
    ).rejects.toThrow('root state write setMeta inside transaction; use tx')
    expect(takeRootWriteViolations()).toHaveLength(1)
    expect(await state.getMeta('count')).toBeNull()
    expect(await state.getCursor()).toBe(0)
  })

it('permits unrelated root writes while a transaction is suspended', async () => {
  const state = new MemoryStateStore()
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = state.transaction(async (tx) => {
    await tx.setMeta!('tentative', 'private')
    entered()
    await gate
    throw new Error('rollback')
  })
  const result = expect(pending).rejects.toThrow('rollback')
  await ready
  await state.setMeta('outside', 'committed')
  release()
  await result
  expect(takeRootWriteViolations()).toEqual([])
  expect(await state.getMeta('outside')).toBe('committed')
  expect(await state.getMeta('tentative')).toBeNull()
})

for (const method of [
  'put',
  'delete',
  'setCursor',
  'setJournal',
  'setMeta',
  'transaction',
] as const)
  it(`detects a captured root ${method}`, async () => {
    const state = new MemoryStateStore()
    const write = () => {
      switch (method) {
        case 'put':
          return state.put({
            path: 'a',
            wirePath: 'a',
            fileId: 'a',
            versionId: 'v',
            sha: 'a'.repeat(64),
            size: 1,
            mtime: 1,
          })
        case 'delete':
          return state.delete('a')
        case 'setCursor':
          return state.setCursor(1)
        case 'setJournal':
          return state.setJournal(null)
        case 'setMeta':
          return state.setMeta('a', 'b')
        case 'transaction':
          return state.transaction(async () => {})
      }
    }
    await expect(
      state.transaction(async () => {
        await write()
      })
    ).rejects.toThrow(`root state write ${method}`)
    expect(takeRootWriteViolations()).toHaveLength(1)
  })

it('retains evidence of a root write even when the callback swallows the error', async () => {
  const state = new MemoryStateStore()
  await state.transaction(async (tx) => {
    try {
      await state.setMeta('count', '1')
    } catch {
      /* simulate a broad host-hook catch */
    }
    await tx.transaction(async (nested) => {
      await nested.setCursor(1)
    })
  })
  expect(takeRootWriteViolations()).toHaveLength(1)
  expect(await state.getCursor()).toBe(1)
  expect(await state.getMeta('count')).toBeNull()
})

it('does not retain an active guard in tasks that run after their originating callback finishes', async () => {
  const state = new MemoryStateStore()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let later!: Promise<void>
  await state.transaction(async (tx) => {
    later = gate.then(() => state.setMeta('later', 'independent'))
    await tx.setCursor(1)
  })
  release()
  await later
  expect(takeRootWriteViolations()).toEqual([])
  expect(await state.getMeta('later')).toBe('independent')
})
