import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineStatus } from '@abele/sync-core'
import { liveCount, PushProgress, readLive, writeLive } from '../../src/progress.js'

/**
 * The daemon's count of what is left to push, as it falls (B14): the engine lowers `pending`
 * op by op while a push runs, and the daemon passes that on — to a file `status` reads from
 * another process, and now and then as a line for the log and the console.
 */

const status = (state: EngineStatus['state'], pending: number): EngineStatus => ({
  state,
  pending,
  lastSyncAt: null,
  lastError: null,
  cursor: 0,
  headSeq: null,
  heldDeletes: 0,
  deferred: 0,
})

function harness(timing = { fileMs: 250, lineMs: 5_000 }) {
  let now = 0
  const files: Array<number | null> = []
  const lines: string[] = []
  const progress = new PushProgress({
    file: (pending) => files.push(pending),
    say: (line) => lines.push(line),
    now: () => now,
    ...timing,
  })
  return {
    progress,
    files,
    lines,
    at: (ms: number) => {
      now = ms
    },
  }
}

describe('PushProgress', () => {
  it('files the count as it falls, no more often than it is told, and clears it when the sync ends', () => {
    const h = harness()
    h.progress.update(status('syncing', 200))
    h.at(100)
    h.progress.update(status('syncing', 190))
    h.at(300)
    h.progress.update(status('syncing', 150))
    h.at(400)
    h.progress.update(status('syncing', 150))
    h.at(700)
    h.progress.update(status('syncing', 20))
    h.at(800)
    h.progress.update(status('idle', 0))
    expect(h.files).toEqual([200, 150, 20, null])
  })

  it('says how many are left now and then while the count falls, not on every op', () => {
    const h = harness()
    h.progress.update(status('syncing', 200))
    h.at(1_000)
    h.progress.update(status('syncing', 180))
    h.at(5_500)
    h.progress.update(status('syncing', 120))
    h.at(6_000)
    h.progress.update(status('syncing', 110))
    h.at(11_000)
    h.progress.update(status('syncing', 30))
    h.at(12_000)
    h.progress.update(status('idle', 0))
    expect(h.lines).toEqual(['push: 120 of 200 left', 'push: 30 of 200 left'])
  })

  it('starts counting afresh at the next sync', () => {
    const h = harness({ fileMs: 0, lineMs: 0 })
    h.progress.update(status('syncing', 3))
    h.progress.update(status('syncing', 2))
    h.progress.update(status('idle', 0))
    h.progress.update(status('syncing', 5))
    h.progress.update(status('syncing', 4))
    expect(h.files).toEqual([3, 2, null, 5, 4])
    expect(h.lines).toEqual(['push: 2 of 3 left', 'push: 4 of 5 left'])
  })
})

describe('the live count on disk', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('is read back as written, and gone once cleared', async () => {
    dir = await mkdtemp(join(tmpdir(), 'abele-live-'))
    expect(readLive(dir)).toBeNull()
    writeLive(dir, 42)
    expect(readLive(dir)).toMatchObject({ pid: process.pid, pending: 42 })
    writeLive(dir, null)
    expect(readLive(dir)).toBeNull()
  })

  it('counts only while the process that wrote it is the daemon holding the vault', async () => {
    dir = await mkdtemp(join(tmpdir(), 'abele-live-'))
    writeLive(dir, 7)
    expect(liveCount(dir, () => process.pid)).toBe(7)
    // No daemon, or another one: what a killed daemon left behind is not a count.
    expect(liveCount(dir, () => null)).toBeNull()
    expect(liveCount(dir, () => process.pid + 1)).toBeNull()
  })
})
