import { expect, it } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites } from '../../src/index.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'

import { change } from './holdFixture.js'

it('D-119 loads 250000 durable holds without spreading them into function arguments', async () => {
  const state = new MemoryStateStore(),
    item = await change(0)
  await state.setMeta(
    'pull-held-progress',
    JSON.stringify({
      generation: null,
      head: 250000,
      inventoryComplete: true,
      holds: Array.from({ length: 250000 }, (_, n) => ({
        change: { ...item, seq: n + 1, file_id: `f${n}`, path: `${n}.bin` },
        base: null,
        firstSeq: n + 1,
      })),
    })
  )
  const client = {
    manifest: async () => {
      throw new Error('loaded all holds')
    },
  } as unknown as EngineClient
  await expect(
    pull(client, new MemoryFileSystem(), state, {
      dirty: new Set(),
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    })
  ).rejects.toThrow('loaded all holds')
}, 30000)
