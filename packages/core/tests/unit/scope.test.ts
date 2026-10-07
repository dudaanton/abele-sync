import { describe, it, expect } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, type StateEntry } from '../../src/index.js'
import { AsideMarks, ScopeMarks } from '../../src/scope.js'
import { guarded } from '../../src/guard.js'

const entry = (path: string, fileId: string): StateEntry => ({
  path,
  wirePath: path,
  fileId,
  versionId: `${fileId}-v1`,
  sha: 'a'.repeat(64),
  size: 2,
  mtime: 1,
})

const skipping = (folder: string) => ({
  excluded: (path: string) => path.startsWith(`${folder}/`),
})
const everything = { excluded: () => false }

/**
 * A file gone while out of scope has its entry dropped, and the feed
 * must be rewound before that, not after: killed between the two, a dropped entry with the
 * cursor still past the file's last change leaves the file missing here with nothing to fetch it.
 */
describe('ScopeMarks.review', () => {
  it('rewinds the cursor before it drops an entry', async () => {
    const state = new MemoryStateStore()
    const fs = new MemoryFileSystem()
    await state.put(entry('Burst/x.md', 'f1'))
    await state.setCursor(42)
    const marks = new ScopeMarks(state)
    await marks.review(fs, skipping('Burst'))

    // The process dies at the first drop.
    const cursorAtDrop: number[] = []
    const drop = state.delete.bind(state)
    state.delete = async (path) => {
      cursorAtDrop.push(await state.getCursor())
      throw new Error('killed')
      return drop(path)
    }
    await expect(new ScopeMarks(state).review(fs, everything)).rejects.toThrow('killed')
    expect(cursorAtDrop).toEqual([0])
    expect(await state.getCursor()).toBe(0)
  })
})

/**
 * A passed-over path whose local file went asks for a walk, and the feed
 * is rewound before the mark is forgotten. Killed between the two, a forgotten mark with the
 * cursor still past the server's change would leave that file missing here for good.
 */
describe('AsideMarks.due', () => {
  it('rewinds the cursor before it forgets a mark', async () => {
    const state = new MemoryStateStore()
    const fs = new MemoryFileSystem()
    await state.setCursor(42)
    await new AsideMarks(state).add(new Map([['big.png', 'big.png']]))

    // The process dies as the marks are saved without that one.
    const cursorAtSave: number[] = []
    const setMeta = state.setMeta.bind(state)
    state.setMeta = async (key, value) => {
      if (key === 'passed-over-paths') {
        cursorAtSave.push(await state.getCursor())
        throw new Error('killed')
      }
      return setMeta(key, value)
    }
    await expect(new AsideMarks(state).due(fs, everything)).rejects.toThrow('killed')
    expect(cursorAtSave).toEqual([0])
    expect(await state.getCursor()).toBe(0)
  })
})

describe('marks over a store seen through the stillHeld guard', () => {
  it('share one queue with the store itself, so neither writes over the other', async () => {
    const state = new MemoryStateStore()
    const getMeta = state.getMeta.bind(state)
    // A read that takes a moment, so two unqueued read-modify-writes would overlap.
    state.getMeta = async (key) => {
      const value = await getMeta(key)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return value
    }
    const fs = new MemoryFileSystem()
    const client = {} as never
    const seen = guarded({ client, fs, state }, () => true).state
    await Promise.all([
      new AsideMarks(state).add(new Map([['a.md', 'a.md']])),
      new AsideMarks(seen).add(new Map([['b.md', 'b.md']])),
    ])
    const filed = JSON.parse((await getMeta('passed-over-paths')) ?? '{}') as object
    expect(Object.keys(filed).sort()).toEqual(['a.md', 'b.md'])
  })
})
