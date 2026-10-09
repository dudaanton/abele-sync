import { EngineError, type EngineStatus, type SyncEngine } from '@abele/sync-core'
import { acquireLock, LOCK_STALE, type Lock } from '../lock.js'
import { EXIT_REVOKED, EXIT_LOCKED, EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { personalRevocationBinding, recordRevoked, wasRevoked } from '../revoked.js'
import { forgetJoinOnceDone } from '../join.js'
import { codeHeldLine } from '../pluginCode.js'
import { openLog, type Log } from '../log.js'
import { PROGRESS_FILE_MS, PROGRESS_LINE_MS, PushProgress, writeLive } from '../progress.js'
import {
  buildEngine,
  DEFAULT_INTERVAL_SECONDS,
  heldLine,
  isUnauthorized,
  MIN_INTERVAL_SECONDS,
  prepareVault,
  rememberScope,
  rememberSummary,
  rememberVault,
  recoverVault,
  requireConfig,
  requireServerUrl,
  REVOKED_HINT,
  scopeChanged,
  summarise,
  vaultDir,
  type OpenVault,
} from '../vault.js'

/**
 * The daemon.
 *
 * One vault is one process: the lock is taken before anything is opened and dropped however
 * this ends, so two daemons never scan and push the same disk. `--once` syncs and leaves,
 * which is what a cron line or a test wants; otherwise the engine runs on its own triggers —
 * the server's event stream, the file watcher, and the clock behind both — until a signal
 * comes, and then it is stopped properly: the sync in flight is waited for, the state
 * database is closed, the lock is released. A token the server stops taking ends it the same
 * way, with a non-zero exit and a line saying what to do about it: no trigger will change
 * that answer, and a service manager restarting the process would only find it again.
 *
 * Every line goes to two places. The log file is the record `status` reads back later, and
 * standard output is for whoever is watching the process now; the engine's own chatter goes
 * to the log alone, where it is worth having and not worth printing.
 */

export interface RunOptions {
  dir: string
  once?: boolean
  interval?: string
}

export async function runRun(opts: RunOptions, ctx: CommandContext): Promise<number> {
  const dir = vaultDir(opts.dir)
  // A directory that was never set up is not one to take a lock in, and nor is one whose
  // token would go to another machine in the clear.
  requireServerUrl(requireConfig(dir).serverUrl)
  const fallbackMs = intervalSeconds(opts.interval) * 1000
  // Settled from the engine's hook when the token stops working: the daemon waits on it
  // beside the signals, and `--once` has the thrown error itself.
  const revoked = deferred<string>()
  // Settled when the lock stops being this process's: another daemon took it over, or it could
  // not be refreshed for long enough that one may have. This one then stops syncing.
  const lost = deferred<string>()
  let lostWhy: string | null = null

  const daemonMode = opts.once !== true
  // `deletes --confirm | --restore` beside this daemon asks for the sync that carries the
  // decision out now, not at the next interval (GUESS-16). The listener is in place before the
  // lock names this process a daemon, so no signal it invites finds Node's default — which opens
  // the inspector — and it stays until the lock is let go. A signal
  // before the engine is built needs nothing: its first sync takes the decision anyway.
  let poked: (() => void) | null = null
  const onPoke = (): void => poked?.()
  if (daemonMode) process.on('SIGUSR1', onPoke)

  let lock: Lock
  try {
    lock = await acquireLock(dir, {
      ...ctx.lockTiming,
      daemon: daemonMode,
      onLost: (why) => {
        lostWhy = why
        lost.resolve(why)
      },
    })
  } catch (error) {
    if (daemonMode) process.off('SIGUSR1', onPoke)
    if (error instanceof EngineError && error.code === 'conflict') {
      ctx.io.err(error.message)
      return EXIT_LOCKED
    }
    throw error
  }

  // Everything opened after the lock is opened inside the same `try`, so a failure on the way
  // up — a state database that will not open, a config the engine will not take — still drops
  // the lock and closes what did open.
  let vault: OpenVault | null = null
  let engine: SyncEngine | null = null
  let terminalRevoked = false
  try {
    const log = openLog(dir)
    vault = await prepareVault(dir, ctx, lock.held)
    if (wasRevoked(vault.state, personalRevocationBinding(vault.cfg))) {
      const line = 'stopping: device token was revoked or is no longer authorized'
      log.line(line)
      ctx.io.err(line)
      ctx.io.err(REVOKED_HINT)
      return EXIT_REVOKED
    }
    await recoverVault(vault, lock.held)
    // Under the lock, and only here: what a killed daemon left half-written is nobody's now.
    vault.disk.sweepTemp()
    rememberVault(vault)
    const opened = vault
    engine = buildEngine(vault, {
      fallbackMs,
      // The run in flight stops at its next commit or write once the lock is not ours for sure,
      // rather than finishing beside whoever holds the vault next.
      stillHeld: lock.held,
      log: (line) => log.line(line),
      onSync: (report) => {
        const line = summarise(report)
        log.line(line)
        rememberSummary(opened, line)
        if (daemonMode) {
          ctx.io.out(line)
          if (report.deferred > 0) ctx.io.out(codeHeldLine(report.deferred))
        }
        if (forgetJoinOnceDone(dir, report)) {
          log.line('join: done; the preference is no longer in the config')
        }
      },
      onFail: (error, kind) => {
        if (kind === 'unauthorized') revoked.resolve(messageOf(error))
      },
    })
    if (!daemonMode) {
      const code = await syncOnce(engine, vault, ctx, log)
      if (lostWhy === null) return code
      ctx.io.err(`the vault's lock is no longer this process's: ${String(lostWhy)}`)
      return EXIT_LOCKED
    }
    const running = engine
    poked = () => {
      log.line('sync: asked for by a signal')
      void running.sync().catch(noop)
    }
    const code = await daemon(engine, vault, ctx, log, revoked.promise, lost.promise)
    terminalRevoked = code === EXIT_REVOKED
    return code
  } catch (error) {
    // The run stopped at a step the lock no longer covered, maybe
    // before the lock's own timer said so: the same exit as a lock the timer saw go.
    if (error instanceof EngineError && error.code === 'lost') {
      lostWhy ??= error.message
      ctx.io.err(`the vault's lock is no longer this process's: ${String(lostWhy)}`)
      return EXIT_LOCKED
    }
    if (!isUnauthorized(error)) throw error
    const line = 'stopping: device token was revoked or is no longer authorized'
    openLog(dir).line(line)
    ctx.io.err(line)
    ctx.io.err(messageOf(error))
    ctx.io.err(REVOKED_HINT)
    terminalRevoked = true
    return EXIT_REVOKED
  } finally {
    if (engine !== null) await engine.stop()
    if (
      terminalRevoked &&
      vault &&
      !recordRevoked(vault.state, personalRevocationBinding(vault.cfg))
    )
      ctx.io.err('revoked status could not be saved; recover the local ledger before restarting')
    // Nothing is in flight now, so nothing of ours is in the temp folder; a clean exit leaves
    // none behind. A lost lock leaves it alone: it may be the next holder's by now.
    if (lostWhy === null && lock.held() && vault?.recovery) {
      try {
        vault.recovery.assertReady()
        vault.disk.removeTemp()
      } catch {
        /* recovery/lost ownership preserves all artifacts */
      }
    }
    vault?.close()
    lock()
    // Only once the lock no longer names this process a daemon.
    if (daemonMode) process.off('SIGUSR1', onPoke)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** One sync, and what it did. A failure is the caller's to report and to exit on. */
async function syncOnce(
  engine: SyncEngine,
  vault: OpenVault,
  ctx: CommandContext,
  log: Log
): Promise<number> {
  const report = await (rescanDue(vault, log) ? engine.rescan() : engine.sync())
  rememberScope(vault)
  // The hook has logged the line and filed it; whoever ran this wants to see it too.
  ctx.io.out(summarise(report))
  if (report.deferred > 0) ctx.io.out(codeHeldLine(report.deferred))
  // Held deletes are a question for a person, not a failure: the run still did its job, and a
  // cron line that treats non-zero as broken would only nag (GUESS-16: exit 0).
  if ((engine.status.heldDeletes ?? 0) > 0) {
    ctx.io.out(heldLine(vault.dir, await engine.heldDeletes()))
  }
  return EXIT_OK
}

/**
 * Whether this run has to walk the manifest again before it follows the feed: the selective
 * settings or the ignore file are not the ones the last sync ran on, so the feed has moved
 * past files this device passed over and now wants. Says so in the log, since a rescan of a
 * large vault is a noticeably longer sync.
 */
function rescanDue(vault: OpenVault, log: Log): boolean {
  if (!scopeChanged(vault)) return false
  log.line('rescan: what this device syncs changed since the last sync')
  return true
}

/** The engine on its own triggers, until a signal says to stop — or the token stops working. */
async function daemon(
  engine: SyncEngine,
  vault: OpenVault,
  ctx: CommandContext,
  log: Log,
  revocation: Promise<string>,
  lost: Promise<string>
): Promise<number> {
  const say = (line: string): void => {
    log.line(line)
    ctx.io.out(line)
  }
  say(
    vault.disk.supportsWatch
      ? `watching ${vault.dir}`
      : `syncing ${vault.dir} on the clock: this filesystem cannot be watched`
  )

  // What is left of a push, filed for `status` and said now and then as it falls (B14).
  const progress = new PushProgress({
    fileMs: ctx.progressTiming?.fileMs ?? PROGRESS_FILE_MS,
    lineMs: ctx.progressTiming?.lineMs ?? PROGRESS_LINE_MS,
    file: (pending) => {
      try {
        writeLive(vault.dir, pending)
      } catch (error) {
        log.line(`status: the count of what is left not filed: ${messageOf(error)}`)
      }
    },
    say,
  })
  // The held set the hint was last printed for: a new set, even of the same size, has a new
  // fingerprint, and the command printed for the old one would be refused.
  let hinted: string | null = null
  const hint = (): void => {
    void engine
      .heldDeletes()
      .then((held) => {
        const line = held.length === 0 ? null : heldLine(vault.dir, held)
        if (line !== null && line !== hinted) say(line)
        hinted = line
      })
      .catch((error: unknown) => log.line(`sync: held deletes not read: ${messageOf(error)}`))
  }

  let previous: EngineStatus | null = null
  const unsubscribe = engine.onStatus((status) => {
    const state = stateLine(status, previous)
    if (state !== null) say(state)
    progress.update(status)
    const held = status.heldDeletes ?? 0
    if (held > 0 && (held !== (previous?.heldDeletes ?? 0) || status.state !== previous?.state)) {
      hint()
    }
    if (held === 0) hinted = null
    // The engine has already written the failure to the log; this is for the console alone.
    const failure = failureLine(status, previous)
    if (failure !== null) ctx.io.out(failure)
    previous = status
  })
  // The rescan is asked for before `start`, so it is the first run and the one `start` prompts
  // queues behind it and follows the feed. It is recorded as done only once it got through: one
  // that fails leaves the key as it was, so the next start walks the manifest again rather than
  // trusting the feed.
  if (rescanDue(vault, log)) {
    void engine
      .rescan()
      .then(() => rememberScope(vault))
      .catch(noop)
  } else {
    rememberScope(vault)
  }
  engine.start()

  const signals = firstSignal()
  const ended = await Promise.race([
    signals.promise.then((signal) => ({ signal })),
    revocation.then((message) => ({ message })),
    lost.then((why) => ({ lost: why })),
  ])
  signals.cancel()
  unsubscribe()
  progress.end()
  if ('signal' in ended) {
    say(`stopping on ${ended.signal}`)
    return EXIT_OK
  }
  if ('lost' in ended) {
    say(`stopping: the vault's lock is no longer this daemon's: ${ended.lost}`)
    ctx.io.err(lostHint(ended.lost, vault.dir))
    return EXIT_LOCKED
  }
  say(`stopping: device token was revoked or is no longer authorized: ${ended.message}`)
  ctx.io.err(REVOKED_HINT)
  return EXIT_REVOKED
}

const noop = (): void => undefined

/**
 * What to do after the lock went, in the words of why it went. A lock no
 * beat could refresh is this machine having slept or stalled — a laptop's lid, most often — and
 * starting again is safe once nothing else runs for the folder; a service manager does it by
 * itself. A lock taken over is another process, which has to be looked at first.
 */
export function lostHint(why: string, dir: string): string {
  if (why.startsWith(LOCK_STALE)) {
    return (
      'this machine slept or stalled for longer than the lock allows, so this daemon stopped ' +
      `rather than risk a second writer; start it again with abele-sync run --dir ${dir} once ` +
      'no other abele-sync runs for this folder. Under launchd or systemd it restarts by itself.'
    )
  }
  return 'another abele-sync may be running for this folder; check before starting again'
}

/** The engine's state, when it changed, in the words the log keeps and `status` reads back. */
function stateLine(status: EngineStatus, previous: EngineStatus | null): string | null {
  if (previous !== null && status.state === previous.state) return null
  return (
    `state: ${status.state} (pending ${status.pending}, cursor ${status.cursor}, ` +
    `head ${status.headSeq ?? '?'})`
  )
}

/** What the last sync said went wrong, once per failure. */
function failureLine(status: EngineStatus, previous: EngineStatus | null): string | null {
  if (status.lastError === null || status.lastError === previous?.lastError) return null
  return `sync: failed: ${status.lastError}`
}

/**
 * The first of the signals a service manager stops a daemon with, and no listener left over —
 * whether a signal came or `cancel` was called first because the daemon ended for a reason of
 * its own.
 */
function firstSignal(): { promise: Promise<NodeJS.Signals>; cancel: () => void } {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
  const handlers = new Map<NodeJS.Signals, () => void>()
  const cancel = (): void => {
    for (const [name, fn] of handlers) process.off(name, fn)
    handlers.clear()
  }
  const promise = new Promise<NodeJS.Signals>((resolve) => {
    for (const signal of signals) {
      const handler = (): void => {
        cancel()
        resolve(signal)
      }
      handlers.set(signal, handler)
      process.once(signal, handler)
    }
  })
  return { promise, cancel }
}

/**
 * `--interval`, in seconds, or the five minutes the engine would have taken anyway.
 *
 * There is a floor: the interval is a fallback for when neither the event stream nor the
 * watcher has spoken, and a vault rescanned every second would spend the day hashing.
 */
function intervalSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INTERVAL_SECONDS
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--interval takes a number of seconds, not ${raw}`)
  }
  if (seconds < MIN_INTERVAL_SECONDS) {
    throw new UsageError(`--interval is at least ${MIN_INTERVAL_SECONDS} seconds, not ${raw}`)
  }
  return seconds
}
