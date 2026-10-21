import { expect, it } from 'vitest'
import { SimScheduler } from './scheduler.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { sha256 } from '../../src/index.js'

it('crash discards uncommitted state and fences stale handles', async () => {
  const scheduler = new SimScheduler(7), state = new DurableStateStore(scheduler)
  await state.setCursor(2)
  await expect(state.transaction(async () => {
    await state.setCursor(9)
    scheduler.crash()
    await state.setCursor(10)
  })).rejects.toThrow('epoch')
  expect(await state.reopen().getCursor()).toBe(2)
  await expect(state.setCursor(99)).rejects.toThrow('epoch')
})

it('stages survive a crash, authenticate bytes and publish atomically', async () => {
  const scheduler = new SimScheduler(3), fs = new MemoryStreamingFS(scheduler)
  const bytes = new TextEncoder().encode('new')
  const stage = await fs.beginAtomicWrite('a/b', 1, null)
  await stage.append(0, bytes)
  expect(await fs.stat('a/b')).toBeNull()
  scheduler.crash()
  await expect(stage.commit()).rejects.toThrow('epoch')
  const next = fs.reopen(), recovered = await next.reopenStage(stage.id)
  await recovered.seal({ size: bytes.length, sha: await sha256(bytes) })
  await recovered.commit()
  expect(await next.read('a/b')).toEqual(bytes)
  expect(next.stages.size).toBe(0)
})
