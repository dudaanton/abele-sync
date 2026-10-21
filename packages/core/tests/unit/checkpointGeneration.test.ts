import { expect, it, vi } from 'vitest'
import { MemoryStateStore } from '../../src/state.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { GENERATION_KEY, reconcileGeneration } from '../../src/restoreGeneration.js'
import { ExpectedWrites } from '../../src/echo.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'

for (const transition of ['restore', 'mismatch'] as const)
  it(`D-033 rejects an old manifest checkpoint after generation ${transition}`, async () => {
    const state = new MemoryStateStore()
    await state.setMeta(GENERATION_KEY, 'old')
    await state.setMeta(
      'pull-manifest-progress',
      JSON.stringify({ head: 100, generation: 'old', completed: [], seen: [], firstHeld: null })
    )
    await state.setMeta(
      'pull-manifest-page',
      JSON.stringify({ items: [], next: null, head_seq: 100 })
    )
    if (transition === 'restore') await reconcileGeneration(state, 'new')
    else await state.setMeta(GENERATION_KEY, 'new')
    const manifest = vi.fn(async () => ({ items: [], next: null, head_seq: 10 }))
    const changes = vi.fn(async () => ({ items: [], next_since: 10, head_seq: 10 }))
    await pull({ manifest, changes } as unknown as EngineClient, new MemoryFileSystem(), state, {
      expected: new ExpectedWrites(),
      dirty: new Set(),
      filter: { excluded: () => false },
    })
    expect(manifest).toHaveBeenCalledTimes(1)
    expect(changes).toHaveBeenCalledWith(10, expect.any(Number))
    expect(await state.getCursor()).toBe(10)
  })
