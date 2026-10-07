import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineError, selectiveDefaults } from '@abele/sync-core'
import { writeConfig, type DaemonConfig } from '../../src/config.js'
import {
  acquireLock,
  currentBoot,
  giveUpMs,
  localDaemon,
  lockHolder,
  pidNamespace,
  removeIf,
} from '../../src/lock.js'

const POSIX_MODES = process.platform !== 'win32'

const config = (): DaemonConfig => ({
  serverUrl: 'https://sync.example.test',
  deviceToken: 'dt_test',
  vaultId: 'v1',
  deviceId: 'd1',
  deviceName: 'laptop',
  selective: selectiveDefaults(),
})

let dir: string
const stateDir = (): string => join(dir, '.abele-sync')
const lockFile = (): string => join(stateDir(), 'lock')
const firstLine = (): string | undefined => readFileSync(lockFile(), 'utf8').split('\n')[0]
const identity = (): Record<string, unknown> =>
  JSON.parse(readFileSync(lockFile(), 'utf8').split('\n')[1] ?? '{}') as Record<string, unknown>
function writeLock(pid: number, record: Record<string, unknown>): void {
  writeFileSync(lockFile(), `${pid}\n${JSON.stringify(record)}\n`)
}
/** This machine, this boot, this pid namespace, as a lock written here now says. */
const here = (instance: string): Record<string, unknown> => {
  const ns = pidNamespace()
  return {
    instance,
    host: hostname(),
    boot: currentBoot(),
    ...(ns === null ? {} : { ns }),
    beat: 0,
  }
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Another holder that beats: its lock's beat goes up every few ms until stopped, each write
 * stamped by the holder's own clock, `skewMs` off this one's.
 */
function beating(pid: number, record: Record<string, unknown>, skewMs = 0): () => void {
  let beat = 0
  const write = (): void => {
    writeLock(pid, { ...record, beat: beat++ })
    if (skewMs === 0) return
    const theirs = new Date(Date.now() + skewMs)
    utimesSync(lockFile(), theirs, theirs)
  }
  write()
  const timer = setInterval(write, 5)
  return () => clearInterval(timer)
}

/** Short enough for a test, and the watch still several beats long. */
const FAST = { heartbeatMs: 10, watchMs: 120 }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-lock-'))
  writeConfig(dir, config())
})

afterEach(async () => {
  if (POSIX_MODES) chmodSync(stateDir(), 0o700)
  await rm(dir, { recursive: true, force: true })
})

describe('acquireLock', () => {
  it('writes the pid and refuses a second acquire while it is held', async () => {
    const release = await acquireLock(dir)
    expect(firstLine()).toBe(String(process.pid))
    await expect(acquireLock(dir)).rejects.toThrow(EngineError)
    await expect(acquireLock(dir)).rejects.toMatchObject({ code: 'conflict' })
    release()
  })

  it('lets the next process in once the lock is released, and releases twice safely', async () => {
    ;(await acquireLock(dir))()
    expect(existsSync(lockFile())).toBe(false)
    const release = await acquireLock(dir)
    release()
    release()
    ;(await acquireLock(dir))()
  })

  it('takes over a lock whose pid is gone', async () => {
    const dead = spawnSync(process.execPath, ['-e', '""']).pid
    writeFileSync(lockFile(), String(dead))
    const release = await acquireLock(dir)
    expect(firstLine()).toBe(String(process.pid))
    release()
  })

  it('takes over a lock file that says nothing useful', async () => {
    writeFileSync(lockFile(), 'not a pid\n')
    const release = await acquireLock(dir)
    expect(firstLine()).toBe(String(process.pid))
    release()
  })

  // A container's daemon is pid 1 in every life: after a kill the lock it left names the pid
  // the next one has, and "is pid 1 alive" is always yes (three-node report, B3).
  it('takes over a lock naming this very pid from an earlier life of it', async () => {
    writeLock(process.pid, here('an-earlier-life'))
    const release = await acquireLock(dir)
    expect(firstLine()).toBe(String(process.pid))
    release()
    expect(existsSync(lockFile())).toBe(false)
  })

  it('takes over a one-line lock from an older build that names this very pid', async () => {
    writeFileSync(lockFile(), `${process.pid}\n`)
    ;(await acquireLock(dir))()
  })

  it('refuses a lock another live process on this machine holds, in either form', async () => {
    writeLock(process.ppid, here('theirs'))
    await expect(acquireLock(dir)).rejects.toThrow(/another abele-sync is running/)
    writeFileSync(lockFile(), `${process.ppid}\n`)
    await expect(acquireLock(dir)).rejects.toThrow(/another abele-sync is running/)
  })

  // The same lock is refused with this boot and taken with another, so
  // the boot is what decides, and the lock was read, not passed over as holderless.
  it('takes over a live pid’s lock written before this machine last started', async () => {
    writeLock(process.ppid, here('theirs'))
    await expect(acquireLock(dir)).rejects.toThrow(/another abele-sync is running/)
    writeLock(process.ppid, { ...here('theirs'), boot: 'a-boot-long-gone' })
    ;(await acquireLock(dir))()
  })
})

// Two containers with one host name, or a container beside the host.
describe('a lock from another pid namespace on a machine of this name', () => {
  it('is not taken over for naming this very pid while its holder beats', async () => {
    const stop = beating(process.pid, { ...here('another-container'), ns: 'pid:[another]' })
    try {
      await expect(acquireLock(dir, FAST)).rejects.toThrow(/another abele-sync is running/)
    } finally {
      stop()
    }
  })

  it('is not taken over for naming a pid that does not run here while its holder beats', async () => {
    const dead = spawnSync(process.execPath, ['-e', '""']).pid
    const stop = beating(dead, { ...here('the-host-daemon'), ns: 'pid:[host]' })
    try {
      await expect(acquireLock(dir, FAST)).rejects.toThrow(/another abele-sync is running/)
    } finally {
      stop()
    }
  })

  it('is taken over once its holder has stopped beating', async () => {
    writeLock(process.pid, { ...here('another-container'), ns: 'pid:[another]' })
    ;(await acquireLock(dir, FAST))()
  })
})

// Liveness is a change the watcher sees, not two clocks compared.
describe('a lock from another machine', () => {
  it('is refused while its beat moves, its clock ten minutes behind this one', async () => {
    const stop = beating(
      4242,
      { instance: 'theirs', host: 'another-machine', boot: 'b' },
      -10 * 60_000
    )
    try {
      await expect(acquireLock(dir, FAST)).rejects.toThrow(/another-machine/)
    } finally {
      stop()
    }
  })

  it('is taken over when nothing in it changes, however fresh its mtime reads', async () => {
    writeLock(4242, { instance: 'theirs', host: 'another-machine', boot: 'b', beat: 7 })
    const ahead = new Date(Date.now() + 10 * 60_000)
    utimesSync(lockFile(), ahead, ahead)
    ;(await acquireLock(dir, FAST))()
  })
})

describe('holding the lock', () => {
  it('beats: the count in the file goes up', async () => {
    const release = await acquireLock(dir, FAST)
    const before = identity().beat as number
    await sleep(60)
    expect(identity().beat as number).toBeGreaterThan(before + 1)
    release()
  })

  it.skipIf(!POSIX_MODES || process.getuid?.() === 0)(
    'keeps beating after a read that failed',
    async () => {
      const lost: string[] = []
      const release = await acquireLock(dir, { ...FAST, onLost: (why) => lost.push(why) })
      chmodSync(lockFile(), 0o000)
      await sleep(40)
      chmodSync(lockFile(), 0o600)
      const after = identity().beat as number
      await sleep(40)
      expect(identity().beat as number).toBeGreaterThan(after)
      expect(lost).toEqual([])
      release()
    }
  )

  it('says so when another process took the lock over', async () => {
    const lost: string[] = []
    const release = await acquireLock(dir, { ...FAST, onLost: (why) => lost.push(why) })
    writeLock(4242, { instance: 'theirs', host: 'another-machine', boot: 'b', beat: 0 })
    await sleep(40)
    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatch(/taken over by pid 4242 on another-machine/)
    expect(release.held()).toBe(false)
    // Not ours any more, so the release leaves it where it is.
    release()
    expect(firstLine()).toBe('4242')
  })

  it('is held until released, and not after', async () => {
    const release = await acquireLock(dir, FAST)
    expect(release.held()).toBe(true)
    release()
    expect(release.held()).toBe(false)
  })

  it('is not relied on past the give-up, even before the timer has noticed a stall', async () => {
    const lost: string[] = []
    const timing = { heartbeatMs: 20, watchMs: 200 }
    const release = await acquireLock(dir, { ...timing, onLost: (why) => lost.push(why) })
    // A synchronous stall: no timer runs, no beat lands.
    const until = performance.now() + giveUpMs(timing.heartbeatMs, timing.watchMs) + 10
    while (performance.now() < until) {
      /* busy */
    }
    expect(lost).toEqual([])
    expect(release.held()).toBe(false)
    release()
  })

  it.skipIf(!POSIX_MODES || process.getuid?.() === 0)(
    'gives up strictly before a watcher may take over',
    async () => {
      const lost: number[] = []
      const timing = { heartbeatMs: 25, watchMs: 500 }
      const release = await acquireLock(dir, {
        ...timing,
        onLost: () => lost.push(performance.now()),
      })
      await sleep(30)
      // No beat lands after this; the last one landed no later than now.
      chmodSync(stateDir(), 0o500)
      const stopped = performance.now()
      // A watcher that read the lock at `stopped` takes over at `stopped + watch` at the soonest.
      // Asked at one exact instant a beat before that, without yielding to any timer, so how
      // late a busy machine wakes this test cannot move the question: `held()` answers from
      // the last beat and the clock alone.
      await sleep(timing.watchMs / 2)
      const deadline = stopped + timing.watchMs - timing.heartbeatMs
      while (performance.now() < deadline) {
        /* busy, to the instant */
      }
      expect(release.held()).toBe(false)
      // And it says so, however late the timer gets to run on a busy machine.
      while (lost.length === 0 && performance.now() - stopped < timing.watchMs * 20) await sleep(2)
      chmodSync(stateDir(), 0o700)
      expect(lost).toHaveLength(1)
      release()
    }
  )

  it.skipIf(!POSIX_MODES || process.getuid?.() === 0)(
    'says so when no beat could be written for as long as a watcher waits',
    async () => {
      const lost: string[] = []
      const release = await acquireLock(dir, { ...FAST, onLost: (why) => lost.push(why) })
      // The folder read-only: the next beat's temp file cannot be made.
      chmodSync(stateDir(), 0o500)
      await sleep(FAST.watchMs + 60)
      chmodSync(stateDir(), 0o700)
      expect(lost).toHaveLength(1)
      expect(lost[0]).toMatch(/could not be refreshed/)
      release()
    }
  )
})

describe('removing a lock judged stale', () => {
  it('removes it while it is still the lock that was judged', () => {
    writeLock(4242, { instance: 'stale', host: 'another-machine', boot: 'b', beat: 3 })
    const text = readFileSync(lockFile(), 'utf8')
    removeIf(lockFile(), (now) => now === text)
    expect(existsSync(lockFile())).toBe(false)
  })

  it('leaves a lock another starter created since, and leaves nothing else behind', async () => {
    writeLock(4242, { instance: 'stale', host: 'another-machine', boot: 'b', beat: 3 })
    const stale = readFileSync(lockFile(), 'utf8')
    // Between this starter's watch and its removal, another took the stale lock over.
    writeLock(5151, { instance: 'fresh', host: 'yet-another', boot: 'c', beat: 0 })
    const fresh = readFileSync(lockFile(), 'utf8')
    removeIf(lockFile(), (now) => now === stale)
    expect(readFileSync(lockFile(), 'utf8')).toBe(fresh)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(stateDir()).filter((name) => name.startsWith('lock'))).toEqual(['lock'])
  })

  it('is a no-op on a lock already gone', () => {
    expect(() => removeIf(lockFile(), () => true)).not.toThrow()
  })
})

describe('who a decision may be sent to', () => {
  it('names a running daemon on this machine, and nothing that is not one', async () => {
    const plain = await acquireLock(dir, FAST)
    // `run --once`, `restore`, `join`: a signal would open their inspector, or end them.
    expect(localDaemon(dir)).toBeNull()
    plain()
    const daemon = await acquireLock(dir, { ...FAST, daemon: true })
    expect(localDaemon(dir)).toBe(process.pid)
    expect(identity()['daemon']).toBe(true)
    daemon()
    expect(localDaemon(dir)).toBeNull()
  })

  it('names no daemon on another machine, nor a pid the lock does not name alive', () => {
    writeLock(process.ppid, { ...here('elsewhere'), host: 'another-machine', daemon: true })
    expect(localDaemon(dir)).toBeNull()
    writeLock(999_999_999, { ...here('gone'), daemon: true })
    expect(localDaemon(dir)).toBeNull()
  })

  it('tells a holder on this machine from one on another', () => {
    expect(lockHolder(dir)).toBeNull()
    writeLock(process.ppid, { ...here('mine') })
    expect(lockHolder(dir)).toEqual({ here: true, host: hostname() })
    writeLock(4242, { ...here('theirs'), host: 'another-machine' })
    expect(lockHolder(dir)).toEqual({ here: false, host: 'another-machine' })
    writeFileSync(lockFile(), `${process.ppid}\n`)
    expect(lockHolder(dir)).toEqual({ here: true, host: null })
  })
})
