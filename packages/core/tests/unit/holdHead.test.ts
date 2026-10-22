import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites } from '../../src/index.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'

import { change } from './holdFixture.js'

it('D-117 resumes an interrupted held inventory from its real manifest head', async () => {
  const state = new MemoryStateStore(),
    fs = new MemoryFileSystem()
  const a = await change(9),
    b = await change(19)
  let crash = true
  const changes = vi.fn(async () => ({ items: [], head_seq: 100, next_since: 100 }))
  const client = {
    manifest: async (cursor: string | null) => {
      if (cursor !== null && crash) throw new Error('manifest crash')
      return {
        items: cursor === null ? [a] : [b],
        head_seq: 100,
        next: cursor === null ? 'later' : null,
      }
    },
    changes,
  } as unknown as EngineClient
  const run = () =>
    pull(client, fs, state, {
      dirty: new Set([a.path, b.path]),
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    })
  await expect(run()).rejects.toThrow('manifest crash')
  crash = false
  expect((await run()).held).toHaveLength(2)
  expect(changes.mock.calls[0]).toEqual([100, expect.any(Number)])
})
