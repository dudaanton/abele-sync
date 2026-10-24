import { afterEach, expect, it, vi } from 'vitest'
import {
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  push,
  type EngineClient,
} from '../../src/index.js'
import { bindScanScheduling } from '../../src/scanWork.js'

afterEach(() => vi.restoreAllMocks())

it.each([false, true])(
  'yields during 33k admission on count or time budget (time=%s)',
  async (timeBudget) => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const state = new MemoryStateStore()
    let visited = 0,
      last = 0,
      largest = 0,
      checkpoints = 0
    bindScanScheduling(state, () => ({
      yieldTask: async () => {
        largest = Math.max(largest, visited - last)
        last = visited
        checkpoints++
      },
    }))
    const client = {
      pathRefusal: () => {
        visited++
        if (timeBudget) clock++
        return undefined
      },
      hasBlob: async () => {
        throw new Error('sample upload boundary')
      },
    } as unknown as EngineClient
    const ops = Array.from({ length: 33000 }, (_, i) => ({
      op: 'create' as const,
      path: `Notes/Section ${i % 31}/层/Sample ${i}.md`,
      sha: 'a'.repeat(64),
      size: 1,
      mtime: 1,
    }))
    await expect(
      push(
        client,
        new MemoryFileSystem(),
        state,
        {
          ops,
          hashes: new Map(),
          infos: new Map(),
          diskPaths: new Map(),
          dirty: new Set(),
          skipped: [],
          collisions: [],
        },
        { expected: new ExpectedWrites() }
      )
    ).rejects.toThrow('sample upload boundary')
    expect(visited).toBe(33000)
    expect(checkpoints).toBeGreaterThanOrEqual(128)
    largest = Math.max(largest, visited - last)
    expect(largest).toBeLessThanOrEqual(timeBudget ? 8 : 256)
  }
)

it('honors state scheduling cancellation at an admission checkpoint', async () => {
  const state = new MemoryStateStore(),
    controller = new AbortController()
  let visited = 0
  bindScanScheduling(state, () => ({
    signal: controller.signal,
    yieldTask: async () => controller.abort(),
  }))
  const client = {
    pathRefusal: () => {
      visited++
      return undefined
    },
    hasBlob: async () => {
      throw new Error('upload must not start')
    },
  } as unknown as EngineClient
  const ops = Array.from({ length: 1000 }, (_, i) => ({
    op: 'create' as const,
    path: `Notes/Sample ${i}.md`,
    sha: 'a'.repeat(64),
    size: 1,
    mtime: 1,
  }))
  await expect(
    push(
      client,
      new MemoryFileSystem(),
      state,
      {
        ops,
        hashes: new Map(),
        infos: new Map(),
        diskPaths: new Map(),
        dirty: new Set(),
        skipped: [],
        collisions: [],
      },
      { expected: new ExpectedWrites() }
    )
  ).rejects.toThrow('sync stopped')
  expect(visited).toBeLessThanOrEqual(256)
  expect(await state.getJournal()).toBeNull()
})
