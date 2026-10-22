import { expect, it } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites } from '../../src/index.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'

import { change } from './holdFixture.js'
import { reconcileGeneration } from '../../src/restoreGeneration.js'

it('D-118 serializes only linear metadata bytes for 10000 held inventory items', async () => {
  const count = 10000,
    state = new MemoryStateStore(),
    item = await change(0)
  const items = Array.from({ length: count }, (_, n) => ({
    ...item,
    seq: n + 1,
    file_id: `f${n}`,
    version_id: `v${n}`,
    path: `${n}.bin`,
  }))
  let serialized = 0
  const budget = count * 5000
  const setMeta = state.setMeta.bind(state)
  state.setMeta = async (key, value) => {
    serialized += value?.length ?? 0
    if (serialized > budget) throw new Error('nonlinear metadata cost')
    await setMeta(key, value)
  }
  const client = {
    manifest: async (cursor: string | null) => {
      const start = Number(cursor ?? 0),
        end = Math.min(start + 1000, count)
      return {
        items: items.slice(start, end),
        head_seq: count,
        next: end < count ? String(end) : null,
      }
    },
    changes: async () => ({ items: [], head_seq: count, next_since: count }),
  } as unknown as EngineClient
  const report = await pull(client, new MemoryFileSystem(), state, {
    dirty: new Set(items.map((c) => c.path)),
    expected: new ExpectedWrites(),
    filter: { excluded: () => false },
  })
  expect(report.held).toHaveLength(count)
  expect(serialized).toBeLessThanOrEqual(budget)
  // Per-hold records are authority too: a restore must retire them with the header.
  const keys = state.metadataKeys.bind(state)
  Object.defineProperty(state, 'metadataKeys', { value: undefined })
  await reconcileGeneration(state, 'restored')
  expect(keys('pull-held:')).toEqual([])
}, 30000)
