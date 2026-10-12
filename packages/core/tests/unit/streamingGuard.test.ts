import { expect, it } from 'vitest'
import { guarded } from '../../src/guard.js'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import type { EngineClient } from '../../src/engineClient.js'

it('fences returned stages after the engine loses ownership', async () => {
  let held = true
  let effects = 0
  const stage = {
    id: 's',
    offset: 0,
    async append() {
      effects++
    },
    async seal() {
      effects++
    },
    async commit() {
      effects++
    },
    async discard() {
      effects++
    },
  }
  const fs: FileSystem = Object.assign(new MemoryFileSystem(), {
    async beginAtomicWrite() {
      return stage
    },
    async reopenStage() {
      return stage
    },
  })
  const hands = guarded(
    { fs, client: {} as EngineClient, state: new MemoryStateStore() },
    () => held
  )
  const opened = await hands.fs.beginAtomicWrite!('file', 0, null)
  held = false
  await expect(async () => opened.append(0, new Uint8Array([1]))).rejects.toMatchObject({
    code: 'lost',
  })
  expect(effects).toBe(0)
})
