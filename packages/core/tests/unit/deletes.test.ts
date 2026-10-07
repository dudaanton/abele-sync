import { describe, it, expect } from 'vitest'
import type { CommitOp } from '@abele/sync-protocol'
import { DEFAULT_DELETE_GUARD, judgeDeletes, parseDecision, tripsGuard } from '../../src/deletes.js'
import type { StateEntry } from '../../src/index.js'

const entry = (k: number): StateEntry => ({
  path: `n${k}.md`,
  wirePath: `n${k}.md`,
  fileId: `f${k}`,
  versionId: `v${k}`,
  sha: 'a'.repeat(64),
  size: 1,
  mtime: 1,
})
const entries = (n: number): StateEntry[] => Array.from({ length: n }, (_, k) => entry(k))
const deletes = (n: number): CommitOp[] =>
  Array.from({ length: n }, (_, k) => ({
    op: 'delete',
    file_id: `f${k}`,
    base_version_id: `v${k}`,
  }))
const everything = { excluded: () => false }

describe('the delete guard threshold', () => {
  it('holds from 50 deletes, whatever share of the vault they are', () => {
    expect(tripsGuard(49, 1000, DEFAULT_DELETE_GUARD)).toBe(false)
    expect(tripsGuard(50, 1000, DEFAULT_DELETE_GUARD)).toBe(true)
  })

  it('holds from 10 deletes that are a quarter of the vault or more', () => {
    expect(tripsGuard(9, 20, DEFAULT_DELETE_GUARD)).toBe(false)
    expect(tripsGuard(10, 30, DEFAULT_DELETE_GUARD)).toBe(true)
    expect(tripsGuard(10, 40, DEFAULT_DELETE_GUARD)).toBe(true)
    expect(tripsGuard(10, 41, DEFAULT_DELETE_GUARD)).toBe(false)
  })

  it('never holds with the guard off', () => {
    expect(judgeDeletes(deletes(500), entries(500), everything, new Set(), false).held).toEqual([])
  })
})

describe('judgeDeletes', () => {
  it('sends 49 of 1000 and holds 50 of 1000', () => {
    const below = judgeDeletes(
      deletes(49),
      entries(1000),
      everything,
      new Set(),
      DEFAULT_DELETE_GUARD
    )
    expect(below.send).toHaveLength(49)
    expect(below.held).toEqual([])
    const at = judgeDeletes(deletes(50), entries(1000), everything, new Set(), DEFAULT_DELETE_GUARD)
    expect(at.send).toEqual([])
    expect(at.held).toHaveLength(50)
    expect(at.held[0]).toEqual({ path: 'n0.md', fileId: 'f0' })
    expect(at.inScope).toBe(1000)
  })

  it('holds only the deletes and sends everything else', () => {
    const others: CommitOp[] = [
      { op: 'move', file_id: 'f900', base_version_id: 'v900', to_path: 'moved.md' },
      {
        op: 'modify',
        file_id: 'f901',
        base_version_id: 'v901',
        sha: 'b'.repeat(64),
        size: 2,
        mtime: 2,
      },
      { op: 'create', path: 'new.md', sha: 'c'.repeat(64), size: 3, mtime: 3 },
    ]
    const judged = judgeDeletes(
      [...deletes(60), ...others],
      entries(1000),
      everything,
      new Set(),
      DEFAULT_DELETE_GUARD
    )
    expect(judged.send).toEqual(others)
    expect(judged.held).toHaveLength(60)
  })

  it('does not count moves', () => {
    const moves: CommitOp[] = Array.from({ length: 80 }, (_, k) => ({
      op: 'move',
      file_id: `f${k}`,
      base_version_id: `v${k}`,
      to_path: `moved/n${k}.md`,
    }))
    const judged = judgeDeletes(moves, entries(100), everything, new Set(), DEFAULT_DELETE_GUARD)
    expect(judged.send).toEqual(moves)
    expect(judged.held).toEqual([])
  })

  it('passes confirmed deletes and judges the rest without them', () => {
    const confirmed = new Set(Array.from({ length: 50 }, (_, k) => `f${k}`))
    // 50 confirmed and 9 new of 100: the 9 alone are below the floor.
    const judged = judgeDeletes(
      deletes(59),
      entries(100),
      everything,
      confirmed,
      DEFAULT_DELETE_GUARD
    )
    expect(judged.send).toHaveLength(59)
    expect(judged.held).toEqual([])
    // 50 confirmed and 12 new of 40 in scope: the 12 are held, the 50 still go.
    const again = judgeDeletes(
      deletes(62),
      entries(40),
      everything,
      confirmed,
      DEFAULT_DELETE_GUARD
    )
    expect(again.send).toHaveLength(50)
    expect(again.held.map((held) => held.fileId)).toEqual(
      Array.from({ length: 12 }, (_, k) => `f${50 + k}`)
    )
  })

  it('counts the share against the entries this device syncs', () => {
    const skipping = { excluded: (path: string) => path >= 'n5' }
    // 12 deletes of 100 entries is 12 %, but only n0…n4 and n10…n49 are in scope here.
    const all = entries(100)
    const inScope = all.filter((e) => !skipping.excluded(e.wirePath)).length
    const judged = judgeDeletes(deletes(12), all, skipping, new Set(), DEFAULT_DELETE_GUARD)
    expect(judged.inScope).toBe(inScope)
    expect(judged.held.length > 0).toBe(12 / inScope >= 0.25)
  })
})

describe('parseDecision', () => {
  it('reads a decision a host filed, and nothing else', () => {
    const at = '2026-09-27T10:00:00.000Z'
    expect(parseDecision(JSON.stringify({ kind: 'confirm', fileIds: ['a'], at }))).toEqual({
      kind: 'confirm',
      fileIds: ['a'],
      at,
    })
    expect(parseDecision(JSON.stringify({ kind: 'restore', fileIds: ['a', 'b'], at }))?.kind).toBe(
      'restore'
    )
    expect(parseDecision(null)).toBeNull()
    expect(parseDecision('not json')).toBeNull()
    expect(parseDecision(JSON.stringify({ kind: 'forget', fileIds: [], at }))).toBeNull()
    expect(parseDecision(JSON.stringify({ kind: 'confirm', fileIds: [1], at }))).toBeNull()
  })
})

describe('judgeDeletes with a hold already waiting', () => {
  const ids = (from: number, to: number): Set<string> =>
    new Set(Array.from({ length: to - from }, (_, k) => `f${from + k}`))

  it('keeps every delete it held, however few are left', () => {
    const judged = judgeDeletes(
      deletes(9),
      entries(100),
      everything,
      new Set(),
      DEFAULT_DELETE_GUARD,
      {
        sticky: ids(0, 60),
      }
    )
    expect(judged.held).toHaveLength(9)
    expect(judged.counted).toBe(0)
  })

  it('judges only the new deletes, against what the hold leaves', () => {
    // 60 held of 100; 20 more of the 40 left is half of them.
    const joined = judgeDeletes(
      deletes(80),
      entries(100),
      everything,
      new Set(),
      DEFAULT_DELETE_GUARD,
      {
        sticky: ids(0, 60),
      }
    )
    expect(joined.held).toHaveLength(80)
    // 5 more of the 40 left go as they come.
    const sent = judgeDeletes(
      deletes(65),
      entries(100),
      everything,
      new Set(),
      DEFAULT_DELETE_GUARD,
      {
        sticky: ids(0, 60),
      }
    )
    expect(sent.held).toHaveLength(60)
    expect(sent.counted).toBe(5)
  })

  it('counts the deletes sent lately with the new ones', () => {
    const alone = judgeDeletes(deletes(8), entries(76), everything, new Set(), DEFAULT_DELETE_GUARD)
    expect(alone.held).toEqual([])
    const trickle = judgeDeletes(
      deletes(8),
      entries(76),
      everything,
      new Set(),
      DEFAULT_DELETE_GUARD,
      {
        recent: 24,
      }
    )
    expect(trickle.held).toHaveLength(8)
  })
})
