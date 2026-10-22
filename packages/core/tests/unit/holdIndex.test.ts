import { expect, it } from 'vitest'
import { MemoryStateStore } from '../../src/state.js'
import { PullHolds, type HeldChange } from '../../src/pullHolds.js'
import { change } from './holdFixture.js'

it('keeps linked holds and their minimum correct across random insert, update, remove and restart orders', async () => {
  const state = new MemoryStateStore(),
    base = await change(0)
  const expected = new Map<string, HeldChange>()
  let holds = new PullHolds(state),
    random = 118
  await holds.load()
  for (let step = 1; step <= 1000; step++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    const id = `f${(random >>> 8) % 50}`
    const item = { ...base, file_id: id, path: `${id}.bin`, seq: step, version_id: `v${step}` }
    if (random % 3 !== 0) {
      const record = { change: item, base: 'base', firstSeq: expected.get(id)?.firstSeq ?? step }
      expected.set(id, record)
      holds.put(record)
    } else {
      expected.delete(id)
      holds.resolve(item)
    }
    const earliest = expected.size
      ? Math.min(...[...expected.values()].map((h) => h.firstSeq))
      : null
    expect(holds.earliest()).toBe(earliest)
    await state.transaction(async () => {
      await holds.persist(step, true)
      await state.setCursor(earliest === null ? step : earliest - 1)
    })
    if (step % 7 === 0) {
      holds = new PullHolds(state)
      await holds.load()
      expect([...holds.records.values()].map(({ next: _, ...record }) => record)).toEqual([
        ...expected.values(),
      ])
      expect(state.metadataKeys('pull-held:')).toHaveLength(expected.size)
    }
  }
})
