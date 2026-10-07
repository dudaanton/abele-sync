import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { writeConfig } from '../../src/config.js'
import { acquireLock, removeIf } from '../../src/lock.js'

/**
 * The lock against clocks and filesystems the ordinary tests cannot produce: a beat write that hangs, a stall the timer only sees after it, a
 * machine that slept, and a filesystem with no hard links. `node:fs` is seen through a mock
 * that runs the real thing unless a test says otherwise.
 */

const hooks = vi.hoisted(() => ({
  /** Called after every real `renameSync`, with its arguments. */
  afterRename: null as ((from: string, to: string) => void) | null,
  beforeRead: null as ((file: string) => void) | null,
  /** Thrown by `linkSync` instead of linking, when set. */
  linkError: null as string | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: ((file: string, ...rest: unknown[]) => {
      hooks.beforeRead?.(String(file))
      return (real.readFileSync as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof real.readFileSync,
    renameSync: (from: string, to: string) => {
      real.renameSync(from, to)
      hooks.afterRename?.(from, to)
    },
    linkSync: (from: string, to: string) => {
      if (hooks.linkError !== null) {
        throw Object.assign(new Error(`${hooks.linkError}: link`), { code: hooks.linkError })
      }
      real.linkSync(from, to)
    },
  }
})

let dir: string
const lockFile = (): string => join(dir, '.abele-sync', 'lock')
const beatOf = (): number =>
  (JSON.parse(readFileSync(lockFile(), 'utf8').split('\n')[1] ?? '{}') as { beat: number }).beat
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const THEIRS = `4242\n${JSON.stringify({ instance: 'theirs', host: 'another-machine', boot: 'b', beat: 0 })}\n`

/** Beat 10 ms, watch 120 ms: the holder gives up after 100 ms with no beat. */
const FAST = { heartbeatMs: 10, watchMs: 120 }
const LATER = 1_000

/** Both clocks, moved forward by hand on top of the real ones. */
const skew = { mono: 0, wall: 0 }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-lock-clock-'))
  writeConfig(dir, {
    serverUrl: 'https://sync.example.test',
    deviceToken: 'dt_test',
    vaultId: 'v1',
    deviceId: 'd1',
    deviceName: 'laptop',
    selective: selectiveDefaults(),
  })
  skew.mono = 0
  skew.wall = 0
  const now = performance.now.bind(performance)
  const wall = Date.now.bind(Date)
  vi.spyOn(performance, 'now').mockImplementation(() => now() + skew.mono)
  vi.spyOn(Date, 'now').mockImplementation(() => wall() + skew.wall)
})

afterEach(async () => {
  hooks.afterRename = null
  hooks.beforeRead = null
  hooks.linkError = null
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('the give-up clock', () => {
  it('is not set going again by a beat whose write hung past the give-up', async () => {
    const lost: string[] = []
    const lock = await acquireLock(dir, { ...FAST, onLost: (why) => lost.push(why) })
    // The next beat's rename lands a second after the tick that made it began.
    hooks.afterRename = (_from, to) => {
      if (to !== lockFile()) return
      hooks.afterRename = null
      skew.mono += LATER
      skew.wall += LATER
    }
    while (hooks.afterRename !== null) await sleep(2)
    expect(lock.held()).toBe(false)
    await sleep(FAST.heartbeatMs * 3)
    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatch(/could not be refreshed/)
    lock()
  })

  it('is checked before a beat is written, so a tick after a stall writes none', async () => {
    const lost: string[] = []
    const lock = await acquireLock(dir, { ...FAST, onLost: (why) => lost.push(why) })
    await sleep(FAST.heartbeatMs * 2)
    // The event loop stalled past the give-up: the next tick is the first thing to run.
    skew.mono += LATER
    skew.wall += LATER
    const before = beatOf()
    await sleep(FAST.heartbeatMs * 3)
    expect(lost).toHaveLength(1)
    expect(beatOf()).toBe(before)
    expect(lock.held()).toBe(false)
    lock()
  })

  it('runs on the wall clock too, which a sleeping machine moves and the monotonic one does not', async () => {
    const lost: string[] = []
    const lock = await acquireLock(dir, { ...FAST, onLost: (why) => lost.push(why) })
    await sleep(FAST.heartbeatMs * 2)
    skew.wall += LATER
    expect(lock.held()).toBe(false)
    const before = beatOf()
    await sleep(FAST.heartbeatMs * 3)
    expect(lost).toHaveLength(1)
    expect(beatOf()).toBe(before)
    lock()
  })

  it('takes a wall clock set back as no reason to give up', async () => {
    const lost: string[] = []
    const lock = await acquireLock(dir, { ...FAST, onLost: (why) => lost.push(why) })
    skew.wall -= 60 * LATER
    await sleep(FAST.heartbeatMs * 4)
    expect(lock.held()).toBe(true)
    expect(lost).toEqual([])
    lock()
  })
})

describe('a filesystem with no hard links', () => {
  it("puts another holder's lock back when a release finds it in place of its own", async () => {
    const lock = await acquireLock(dir, FAST)
    writeFileSync(lockFile(), THEIRS)
    hooks.linkError = 'EPERM'
    lock()
    expect(readFileSync(lockFile(), 'utf8')).toBe(THEIRS)
  })

  it('puts back a lock that is not the one judged stale, and nothing else is left', async () => {
    writeFileSync(lockFile(), THEIRS)
    hooks.linkError = 'ENOTSUP'
    removeIf(lockFile(), () => false)
    expect(readFileSync(lockFile(), 'utf8')).toBe(THEIRS)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(join(dir, '.abele-sync')).filter((n) => n.startsWith('lock'))).toEqual([
      'lock',
    ])
  })

  it('never exposes a replacement lock to a concurrent starter', () => {
    writeFileSync(lockFile(), THEIRS)
    // A fresh lock replaces the stale one just before removal checks ownership.
    const fresh = `5151\n${JSON.stringify({ instance: 'fresh', host: 'h', boot: 'c', beat: 0 })}\n`
    let injected = false,
      renames = 0
    hooks.afterRename = () => {
      renames++
    }
    hooks.beforeRead = (file) => {
      if (file !== lockFile()) return
      injected = true
      hooks.beforeRead = null
      writeFileSync(file, fresh)
    }
    removeIf(lockFile(), (text) => text === THEIRS)
    // Assert BEFORE reading the outcome; the assertion must not trigger the injection.
    expect(injected).toBe(true)
    expect(hooks.beforeRead).toBeNull()
    hooks.beforeRead = null
    expect(renames).toBe(0)
    expect(readFileSync(lockFile(), 'utf8')).toBe(fresh)
  })
})
