import { expect, it } from 'vitest'
import { SimScheduler } from './scheduler.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { sha256 } from '../../src/index.js'

it('crash discards uncommitted state and fences stale handles', async () => {
  const scheduler = new SimScheduler(7),
    state = new DurableStateStore(scheduler)
  await state.setCursor(2)
  await expect(
    state.transaction(async (tx) => {
      await tx.setCursor(9)
      expect(await state.reopen().getCursor()).toBe(2)
      scheduler.crash()
      await tx.setCursor(10)
    })
  ).rejects.toThrow('epoch')
  expect(await state.reopen().getCursor()).toBe(2)
  await expect(state.setCursor(99)).rejects.toThrow('epoch')
})

it('replays seeded interleavings of concurrent boundaries', async () => {
  const run = async () => {
    const scheduler = new SimScheduler(7),
      order: string[] = []
    await Promise.all(
      ['left', 'right', 'third'].map(async (lane) => {
        for (let n = 0; n < 4; n++) {
          await scheduler.point(lane)
          order.push(`${lane}:${n}`)
        }
      })
    )
    return order
  }
  expect(await run()).toEqual(await run())
})

it('stages survive a crash, authenticate bytes and publish atomically', async () => {
  const scheduler = new SimScheduler(3),
    fs = new MemoryStreamingFS(scheduler)
  const bytes = new TextEncoder().encode('new')
  const stage = await fs.beginAtomicWrite('a/b', 1, null)
  await stage.append(0, bytes)
  expect(await fs.stat('a/b')).toBeNull()
  scheduler.crash()
  await expect(stage.commit()).rejects.toThrow('epoch')
  const next = fs.reopen(),
    recovered = await next.reopenStage(stage.id)
  await recovered.seal({ size: bytes.length, sha: await sha256(bytes) })
  await recovered.commit()
  expect(await next.read('a/b')).toEqual(bytes)
  expect(await recovered.installed!()).toBe(true)
  await recovered.discard()
  expect(next.stages.size).toBe(0)
})

it('file identity lookup follows the last put during a move', async () => {
  const state = new DurableStateStore(new SimScheduler(1))
  const entry = {
    path: 'old',
    wirePath: 'old',
    fileId: 'file',
    versionId: 'version',
    sha: 'sha',
    size: 0,
    mtime: 1,
  }
  await state.put(entry)
  await state.put({ ...entry, path: 'new', wirePath: 'new' })
  expect((await state.byFileId('file'))?.path).toBe('new')
})

it('an in-flight stale filesystem call cannot overwrite restarted bytes', async () => {
  const scheduler = new SimScheduler(8),
    fs = new MemoryStreamingFS(scheduler)
  let arrived!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  scheduler.hook = async (point) => {
    if (point === 'fs.writeAtomic#1') {
      arrived()
      await wait
    }
  }
  const stale = fs.writeAtomic('note.md', new Uint8Array([1]), 1)
  const rejected = expect(stale).rejects.toThrow('epoch')
  await entered
  scheduler.crash()
  scheduler.hook = undefined
  const next = fs.reopen()
  await next.writeAtomic('note.md', new Uint8Array([2]), 2)
  release()
  await rejected
  expect(await next.read('note.md')).toEqual(new Uint8Array([2]))
})
