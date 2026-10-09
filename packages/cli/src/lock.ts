import { randomBytes } from 'node:crypto'
import {
  closeSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { hostname, uptime } from 'node:os'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { EngineError } from '@abele/sync-core'
import { ensureStateFolder, stateFolder } from './config.js'
import { mutateLock, removeIf } from './lockMutation.js'
export { removeIf } from './lockMutation.js'

const LOCK_FILE = 'lock'
const FILE_MODE = 0o600

/** How often a holder writes its next beat into the lock. */
export const HEARTBEAT_MS = 10_000
/**
 * How long a lock nothing on this machine can vouch for is watched before it is taken over:
 * more than four beats, so a holder busy for a while between two of them still counts as alive.
 */
export const WATCH_MS = 45_000

/**
 * How long a holder goes without landing a beat before it counts the lock lost: two beats short
 * of the watch, so it gives up strictly before any watcher can take over.
 *
 * A watcher takes over only when the file did not change for a whole `watch`, measured from a
 * read that came after the holder's last landed beat; so no takeover comes sooner than `watch`
 * after that beat. The holder refuses every commit and write (`Lock.held`) from `watch − 2·beat`
 * after it, and its timer says so within one beat more, `watch − beat` at the latest. With the
 * defaults: refused at 25 s, stopped by 35 s, taken over at 45 s at the soonest. The 20 s left
 * are for one write already under way and a timer that fires late; a process stalled for longer
 * than that is still stopped by `held`, before its next step, but a single step it is in the
 * middle of cannot be. No clock is compared with another machine's.
 *
 * The holder's side holds only if a beat can never move its give-up forward past a takeover
 *, so:
 * - a beat counts from the moment its tick began, before the lock was read, not from when its
 *   write finished: a write that hung on a network drive does not make the lock look fresh;
 * - a tick checks the give-up before it writes, and writes nothing once it has passed: a
 *   process that stalled past it gives up rather than beat over whoever took over meanwhile;
 * - the time since the last beat is taken on the monotonic clock and on the wall clock, and
 *   either one past the give-up is enough. The monotonic clock stops while the machine sleeps;
 *   the wall clock does not, and one set forward costs at worst an early exit 3, which the
 *   service manager restarts. A wall clock set back is not read as time passing.
 * A write already under way when the give-up passes can still land over a new holder's lock;
 * the new holder then finds its lock another's and stops too, which errs on no writer at all.
 */
export const giveUpMs = (heartbeatMs: number, watchMs: number): number => watchMs - 2 * heartbeatMs

/** How a loss for want of a beat begins: the machine slept or stalled, rather than a takeover. */
export const LOCK_STALE = 'the lock could not be refreshed'

export interface LockOptions {
  /**
   * Called once when the lock stops being this process's: another process took it over, or no
   * beat could be written into it for as long as a watcher waits. The daemon stops syncing.
   */
  onLost?: (why: string) => void
  /** How often to beat; `HEARTBEAT_MS` unless a test says otherwise. */
  heartbeatMs?: number
  /** How long to watch a holder only its beats can vouch for; `WATCH_MS` unless a test says. */
  watchMs?: number
  /**
   * Written into the lock by `run` as a daemon, which listens for `SIGUSR1`. Only such a holder
   * is ever signalled (`localDaemon`): to anything else the signal would open Node's inspector,
   * or end it.
   */
  daemon?: boolean
}

/**
 * The release, called to let the lock go, and `held`: whether it is still this process's and
 * fresh enough that nobody can have taken it over. False from the moment it is lost or released.
 */
export type Lock = (() => void) & { held: () => boolean }

/**
 * Claims the vault for this process and hands back the release.
 *
 * The lock file's first line is the holder's pid, as it always was; the second says which life
 * of which process on which machine that is: a random instance id, the host name, the boot, the
 * pid namespace, on Linux the process's start time, and a beat count the holder raises every
 * `HEARTBEAT_MS`. A pid alone is not enough: a container's daemon is pid 1 in every life, so
 * after a kill the lock it left names the very pid the next one has (three-node report, B3).
 *
 * So the holder is judged by what can be known about it:
 * - this machine, this boot, this pid namespace: this very pid is alive only as a lock this
 *   process took itself (anything else is an earlier life of the pid); another pid by whether
 *   it runs and, where the start time was filed, whether it is still the process that started
 *   then;
 * - this machine, an earlier boot: gone;
 * - another machine, or another pid namespace — two containers with one host name, a container
 *   beside the host — or a lock that does not say: nothing here can ask after its pid. The lock
 *   is watched for `WATCH_MS`; a holder whose beat moved in that time is alive, one whose lock
 *   did not change at all is gone. No clock is compared with another, and a transport that
 *   carries only content changes still carries a beat.
 * A live holder is an `EngineError('conflict')`; anything else is stale, and taken over.
 */
export async function acquireLock(dir: string, opts: LockOptions = {}): Promise<Lock> {
  const every = opts.heartbeatMs ?? HEARTBEAT_MS
  const watch = opts.watchMs ?? WATCH_MS
  if (giveUpMs(every, watch) <= every) {
    throw new EngineError('io', `a lock watched for ${watch} ms cannot beat every ${every} ms`)
  }
  const file = join(ensureStateFolder(dir), LOCK_FILE)
  for (let attempt = 0; attempt < 3; attempt++) {
    const identity: LockIdentity = {
      instance: randomBytes(12).toString('hex'),
      host: hostname(),
      boot: currentBoot(),
      ...optional('ns', pidNamespace()),
      ...optional('started', startTimeOf(process.pid)),
      ...(opts.daemon === true ? { daemon: true } : {}),
      beat: 0,
    }
    try {
      const claim = mutateLock(file, () => {
        const fd = openSync(file, 'wx', FILE_MODE)
        try {
          writeSync(fd, lockText(process.pid, identity))
        } finally {
          closeSync(fd)
        }
        return hold(file, identity, opts)
      })
      if (claim === null)
        throw new EngineError(
          'conflict',
          `lock mutation busy in ${dir}; if abandoned, stop all holders before removing lock.mutation`
        )
      return claim.value
    } catch (cause) {
      if (cause instanceof EngineError) throw cause
      if (!isCode(cause, 'EEXIST')) throw new EngineError('io', `cannot lock ${dir}`, cause)
      const read = readLockFile(file)
      // Gone between the create and the read: try again.
      if (read === 'missing') continue
      if (read === 'unreadable') throw new EngineError('io', `cannot read the lock in ${dir}`)
      const live = await liveHolder(file, read, watch)
      if (live !== null) {
        throw new EngineError('conflict', `another abele-sync is running for ${dir} (${live})`)
      }
      // Only the very lock judged stale goes: another starter may have taken it over since.
      removeIf(file, (text) => text === read.text)
    }
  }
  throw new EngineError('conflict', `cannot lock ${dir}: the lock keeps being retaken`)
}

/**
 * The pid of the daemon holding the vault's lock, when it is one this process may signal: a lock
 * `run` took as a daemon, on this machine, this boot and this pid namespace, whose pid still runs
 * and, where the start time was filed, is still the process that started then. Null for anything
 * else — a lock nobody holds, one written elsewhere, a holder that is not a daemon, a pid reused
 * by another program — and the caller then only waits for the holder's next sync.
 */
export function localDaemon(dir: string): number | null {
  const read = readLockFile(join(stateFolder(dir), LOCK_FILE))
  if (read === 'missing' || read === 'unreadable' || read.daemon !== true) return null
  if (read.host !== hostname() || !sameNamespace(read.ns)) return null
  if (read.boot !== undefined && !sameBoot(read.boot, currentBoot())) return null
  if (!isAlive(read.pid)) return null
  const started = startTimeOf(read.pid)
  if (read.started !== undefined && started !== null && started !== read.started) return null
  return read.pid
}

/**
 * Where the lock's holder runs: here — this machine and pid namespace, or a lock too old to say
 * — or on the named host. Null when there is no lock to read.
 */
export function lockHolder(dir: string): { here: boolean; host: string | null } | null {
  const read = readLockFile(join(stateFolder(dir), LOCK_FILE))
  if (read === 'missing' || read === 'unreadable') return null
  if (read.host === undefined) return { here: true, host: null }
  return { here: read.host === hostname() && sameNamespace(read.ns), host: read.host }
}

/** The instance ids of the locks this process holds. */
const held = new Set<string>()

interface LockIdentity {
  instance: string
  host: string
  boot: string
  /** The pid namespace, where the system has them (`/proc/self/ns/pid`). */
  ns?: string
  /** Linux only: the process's start, in clock ticks since boot. */
  started?: string
  /** Raised by the holder on every heartbeat, so a watcher sees it alive by the content alone. */
  beat: number
  /** Set by a daemon `run`, which listens for `SIGUSR1`; see `LockOptions.daemon`. */
  daemon?: boolean
}

interface LockRecord extends Partial<LockIdentity> {
  pid: number
  /** The file as read, for a watcher to compare with a later read. */
  text: string
}

const lockText = (pid: number, identity: LockIdentity): string =>
  `${pid}\n${JSON.stringify(identity)}\n`

/**
 * Holds the lock until the release. Every `HEARTBEAT_MS`, on a timer that keeps nobody alive,
 * the file is read and, while it is still this process's, written again with the next beat.
 *
 * A read or a write that fails is tried again on the next beat: one bad moment on a network
 * drive must not stop the beats for good. The lock is lost — `onLost`, once — only when a read
 * that worked names another instance or finds no lock, or when no beat has landed for as long
 * as a watcher waits, after which another process may have taken it.
 */
function hold(file: string, identity: LockIdentity, opts: LockOptions): Lock {
  held.add(identity.instance)
  const every = opts.heartbeatMs ?? HEARTBEAT_MS
  const giveUp = giveUpMs(every, opts.watchMs ?? WATCH_MS)
  let beat = identity.beat
  let landed = performance.now()
  let landedWall = Date.now()
  let over = false
  const fresh = (): boolean =>
    performance.now() - landed <= giveUp && Date.now() - landedWall <= giveUp
  const stale = (): string => `${LOCK_STALE} for ${Math.round(giveUp / 1000)} s`
  const lose = (why: string): void => {
    if (over) return
    over = true
    clearInterval(timer)
    held.delete(identity.instance)
    opts.onLost?.(why)
  }
  const timer = setInterval(() => {
    // Taken before anything else: the beat this tick writes counts from here.
    const at = performance.now()
    const atWall = Date.now()
    if (!fresh()) return lose(stale())
    const read = readLockFile(file)
    if (read === 'missing') return lose('the lock file was removed')
    // An empty file is a lock being put back where hard links are missing (`removeIf`): half
    // written, not another holder's. The next beat reads it whole.
    if (read !== 'unreadable' && read.text !== '') {
      if (read.instance !== identity.instance) {
        return lose(
          `the lock was taken over by pid ${read.pid}${read.host ? ` on ${read.host}` : ''}`
        )
      }
      if (writeBeat(file, identity, ++beat)) {
        landed = at
        landedWall = atWall
      }
    }
    if (!fresh()) lose(stale())
  }, every)
  timer.unref()
  const release = (): void => {
    over = true
    clearInterval(timer)
    held.delete(identity.instance)
    // Drops the lock only if it is still ours: safe twice, and after someone else took over.
    removeIf(file, (text) => {
      const [, second] = text.split('\n')
      try {
        return (JSON.parse(second ?? '') as { instance?: unknown }).instance === identity.instance
      } catch {
        return false
      }
    })
  }
  // Asked before every step that leaves a mark, so a stall the timer has not caught up with
  // yet is caught here: past the give-up, the lock is not relied on even before it is lost.
  return Object.assign(release, {
    held: () => {
      if (over || !fresh()) return false
      const current = readLockFile(file)
      return (
        current !== 'missing' && current !== 'unreadable' && current.instance === identity.instance
      )
    },
  })
}

/** The next beat, written whole through a temp file so a reader never sees half of it. */
function writeBeat(file: string, identity: LockIdentity, beat: number): boolean {
  const temp = `${file}.${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(temp, lockText(process.pid, { ...identity, beat }), { mode: FILE_MODE })
    return (
      mutateLock(file, () => {
        const read = readLockFile(file)
        if (read === 'missing' || read === 'unreadable' || read.instance !== identity.instance)
          return false
        renameSync(temp, file)
        return true
      })?.value ?? false
    )
  } catch {
    remove(temp)
    return false
  } finally {
    remove(temp)
  }
}

/** Who holds the lock, said for the refusal, or null when the holder cannot be alive. */
async function liveHolder(
  file: string,
  record: LockRecord,
  watchMs: number
): Promise<string | null> {
  const { pid } = record
  // An older build wrote the pid alone. It cannot be this process, which writes the identity.
  if (record.host === undefined) {
    return pid !== process.pid && isAlive(pid) ? `pid ${pid}` : null
  }
  if (record.host === hostname() && sameNamespace(record.ns)) {
    if (record.boot !== undefined && !sameBoot(record.boot, currentBoot())) return null
    if (pid === process.pid) {
      return record.instance !== undefined && held.has(record.instance)
        ? `pid ${pid}, this process`
        : null
    }
    if (!isAlive(pid)) return null
    const started = startTimeOf(pid)
    if (record.started !== undefined && started !== null && started !== record.started) return null
    return `pid ${pid}`
  }
  // Nothing here can ask after that pid: whatever the lock says, only a change to it counts.
  await new Promise((resolve) => setTimeout(resolve, watchMs))
  const again = readLockFile(file)
  if (again === 'missing') return null
  if (again === 'unreadable' || again.text !== record.text) {
    return `pid ${pid} on ${record.host}${record.ns === undefined ? '' : `, ${record.ns}`}`
  }
  return null
}

/**
 * Whether a lock's pid namespace is this process's own. A lock that names none while this
 * system has them was written by a build that did not say, so it cannot be vouched for here.
 */
function sameNamespace(ns: string | undefined): boolean {
  const own = pidNamespace()
  return own === null ? ns === undefined : ns === own
}

function readLockFile(file: string): LockRecord | 'missing' | 'unreadable' {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    return isCode(cause, 'ENOENT') ? 'missing' : 'unreadable'
  }
  const [first, second] = text.split('\n')
  const parsed = Number(first?.trim())
  // 0 signals the whole process group, so anything but a real pid reads as no holder at all.
  const pid = Number.isInteger(parsed) && parsed > 0 ? parsed : 0
  const record: LockRecord = { pid, text }
  try {
    const raw: unknown = JSON.parse(second ?? '')
    if (typeof raw === 'object' && raw !== null) {
      for (const key of ['instance', 'host', 'boot', 'ns', 'started'] as const) {
        const value = (raw as Record<string, unknown>)[key]
        if (typeof value === 'string') record[key] = value
      }
      const beat = (raw as Record<string, unknown>).beat
      if (typeof beat === 'number') record.beat = beat
      if ((raw as Record<string, unknown>).daemon === true) record.daemon = true
    }
  } catch {
    /* the one-line form */
  }
  return record
}

/**
 * Which boot of this machine this is: the kernel's boot id on Linux, the moment it started,
 * to the second, elsewhere. A container reads its host's.
 */
export function currentBoot(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return `at:${Math.round(Date.now() / 1000 - uptime())}`
  }
}

/** This process's pid namespace, `pid:[4026531836]` on Linux; null where there are none. */
export function pidNamespace(): string | null {
  try {
    return readlinkSync('/proc/self/ns/pid')
  } catch {
    return null
  }
}

/** Two boots are one; a boot time read twice may differ by a clock adjustment. */
function sameBoot(a: string, b: string): boolean {
  if (a.startsWith('at:') && b.startsWith('at:')) {
    return Math.abs(Number(a.slice(3)) - Number(b.slice(3))) <= 60
  }
  return a === b
}

/** Linux: the process's start, in clock ticks since boot (field 22 of `/proc/<pid>/stat`). */
function startTimeOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The name in parentheses may hold spaces; the fields after it do not.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

const optional = <K extends string>(key: K, value: string | null): { [P in K]?: string } =>
  (value === null ? {} : { [key]: value }) as { [P in K]?: string }

/** Signal 0 asks the kernel whether the process exists; another user's is alive too. */
function isAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return isCode(cause, 'EPERM')
  }
}

function remove(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    /* already gone */
  }
}

const isCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === code
