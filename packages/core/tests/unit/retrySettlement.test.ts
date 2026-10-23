import { expect, it } from 'vitest'
import { FileRetries } from '../../src/fileRetry.js'
import { MemoryStateStore } from '../../src/state.js'
import { transact } from '../../src/stateTransaction.js'

function fixture() {
  const state = new MemoryStateStore()
  const retries = new FileRetries(
    state,
    () => 10000,
    () => {}
  )
  return { state, retries }
}

it('does not publish retry backoff in memory when its owner transaction rolls back', async () => {
  const { state, retries } = fixture()
  await expect(
    transact(state, async (tx) => {
      await retries.failed('a.md', 'pull', new Error('disk failure'), false, tx)
      expect(retries.has('a.md')).toBe(false)
      throw new Error('owner rollback')
    })
  ).rejects.toThrow('owner rollback')
  expect(await state.getMeta('file-retry:a.md')).toBeNull()
  expect(retries.ready('a.md', 'pull')).toBe(true)
  await transact(state, (tx) =>
    retries.failed('a.md', 'pull', new Error('disk failure'), false, tx)
  )
  expect(retries.list()).toMatchObject([{ attempts: 1 }])
  expect(retries.ready('a.md', 'pull')).toBe(false)
})

it('acknowledges retry retirement only after the outer settlement commits', async () => {
  const { state, retries } = fixture()
  await retries.failed('a.md', 'pull', new Error('disk failure'))
  await expect(
    transact(state, async (tx) => {
      await transact(tx, (nested) => retries.succeeded('a.md', 'pull', nested))
      expect(retries.has('a.md')).toBe(true)
      throw new Error('owner rollback')
    })
  ).rejects.toThrow('owner rollback')
  expect(await state.getMeta('file-retry:a.md')).not.toBeNull()
  expect(retries.has('a.md')).toBe(true)
  await transact(state, async (tx) => {
    await transact(tx, (nested) => retries.succeeded('a.md', 'pull', nested))
    expect(retries.has('a.md')).toBe(true)
  })
  expect(await state.getMeta('file-retry:a.md')).toBeNull()
  expect(retries.has('a.md')).toBe(false)
})

it('leaves raw host transaction acknowledgement to an explicit reload', async () => {
  const { state, retries } = fixture()
  await expect(
    state.transaction(async (tx) => {
      await retries.failed('a.md', 'pull', new Error('disk failure'), false, tx)
      throw new Error('host rollback')
    })
  ).rejects.toThrow('host rollback')
  expect(retries.has('a.md')).toBe(false)
  await state.transaction((tx) =>
    retries.failed('a.md', 'pull', new Error('disk failure'), false, tx)
  )
  expect(retries.has('a.md')).toBe(false)
  await retries.load()
  expect(retries.has('a.md')).toBe(true)
})
