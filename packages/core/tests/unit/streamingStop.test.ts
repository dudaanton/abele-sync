import { expect, it } from 'vitest'
import { stoppableClient } from '../../src/guard.js'
import type { EngineClient } from '../../src/engineClient.js'
import { downloadToStage, TransferBudget } from '../../src/streaming.js'

it('cancellation while sealing prevents publication and closes the source', async () => {
  const controller = new AbortController()
  let release!: () => void
  let sealing!: () => void
  const entered = new Promise<void>((resolve) => {
    sealing = resolve
  })
  let committed = false,
    closed = false
  const source = {
    size: 0,
    signal: controller.signal,
    async read() {
      return new Uint8Array()
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
    async seal() {
      sealing()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
    async commit() {
      committed = true
    },
    async discard() {},
  }
  const transfer = downloadToStage(source, stage, { size: 0, sha: '' }, new TransferBudget())
  await entered
  controller.abort()
  release()
  await expect(transfer).rejects.toThrow()
  expect(committed).toBe(false)
  expect(closed).toBe(true)
})

it('stops an acquired immutable source mid-range and closes it before any late bytes can be used', async () => {
  const controller = new AbortController()
  let finish!: (bytes: Uint8Array) => void
  let closed = 0
  const original = {
    openVersion: async () => ({
      size: 1,
      read: async () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve
        }),
      async assertUnchanged() {},
      async close() {
        closed++
      },
    }),
  } as unknown as EngineClient
  const client = stoppableClient(original, () => controller.signal, { count: 0 })
  const source = await client.openVersion!('f', 'v', { size: 1, sha: '' })
  const read = source.read(0, 1)
  controller.abort()
  await expect(read).rejects.toMatchObject({ code: 'offline' })
  expect(closed).toBe(1)
  finish(new Uint8Array([1]))
  await source.close()
  expect(closed).toBe(1)
}, 1000)

it('closes a source that arrives after the acquisition was cancelled', async () => {
  const controller = new AbortController()
  let finish!: (source: unknown) => void
  let closed = 0
  const client = stoppableClient(
    {
      openVersion: async () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    } as unknown as EngineClient,
    () => controller.signal,
    { count: 0 }
  )
  const opening = client.openVersion!('f', 'v', { size: 1, sha: '' })
  controller.abort()
  await expect(opening).rejects.toMatchObject({ code: 'offline' })
  finish({
    size: 0,
    async read() {
      return new Uint8Array()
    },
    async assertUnchanged() {},
    async close() {
      closed++
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(closed).toBe(1)
})
