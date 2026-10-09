import { randomUUID } from 'node:crypto'
import type { CommitOpResult } from '@abele/sync-protocol'
import { EngineError, type SyncEngine } from '@abele/sync-core'
import { acquireLock, type Lock } from '../lock.js'
import { EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { openLog } from '../log.js'
import { runRestoreSince } from './restoreSince.js'
import { codeHeldLine } from '../pluginCode.js'
import {
  buildEngine,
  DEFAULT_INTERVAL_SECONDS,
  fileIdFor,
  prepareVault,
  requireConfig,
  recoverVault,
  summarise,
  vaultDir,
  wirePath,
  type OpenVault,
} from '../vault.js'

/**
 * Put back a version of a file, or a file that was deleted.
 *
 * The restore itself is the server's: it makes the old version the head again, or takes the
 * file out of the trash. That leaves this disk one version behind, so the command syncs once
 * before it says anything — what it prints is a path a person can open, not a promise that
 * the bytes will turn up when the daemon next runs.
 *
 * Unless a daemon is running. Then the lock is its, the disk is its to write, and the restore
 * is made on the server alone: the daemon hears of the new head through the event stream and
 * brings it down, which is what it is there for. The command says so and exits clean.
 */

export interface RestoreOptions {
  dir: string
  /** The version to go back to; the one before the current head by default. */
  version?: string
  /** A deleted file to bring back: `--deleted <path>`, or `--deleted` beside the path. */
  deleted?: string | boolean
  /** Every file deleted since then, instead of one: see `restoreSince.ts`. */
  deletedSince?: string
  dryRun?: boolean
  yes?: boolean
}

export async function runRestore(
  path: string | undefined,
  opts: RestoreOptions,
  ctx: CommandContext
): Promise<number> {
  if (opts.deletedSince !== undefined) {
    if (path !== undefined || opts.deleted !== undefined || opts.version !== undefined) {
      throw new UsageError('--deleted-since restores every file deleted since then: name no file')
    }
    const dir = vaultDir(opts.dir)
    requireConfig(dir)
    return runRestoreSince(
      dir,
      {
        deletedSince: opts.deletedSince,
        ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
        ...(opts.yes === undefined ? {} : { yes: opts.yes }),
      },
      ctx
    )
  }
  if (opts.dryRun !== undefined || opts.yes !== undefined) {
    throw new UsageError('--dry-run and --yes go with --deleted-since')
  }
  if (opts.deleted !== undefined && opts.version !== undefined) {
    throw new UsageError('--deleted and --version are two different restores: ask for one of them')
  }
  const named = typeof opts.deleted === 'string' ? opts.deleted : path
  if (named === undefined || named === '') {
    throw new UsageError('restore needs a path: `restore --dir DIR PATH`')
  }
  const wire = wirePath(named)
  const dir = vaultDir(opts.dir)
  requireConfig(dir)

  let release: Lock
  try {
    release = await acquireLock(dir)
  } catch (error) {
    if (error instanceof EngineError && error.code === 'conflict') {
      return restoreBesideDaemon(dir, wire, opts, ctx)
    }
    throw error
  }

  // Opened inside the `try`, so a failure on the way up still drops the lock and closes the
  // state database behind it.
  let vault: OpenVault | null = null
  let engine: SyncEngine | null = null
  try {
    const log = openLog(dir)
    vault = await prepareVault(dir, ctx, release.held)
    await recoverVault(vault, release.held)
    engine = buildEngine(vault, {
      stillHeld: release.held,
      fallbackMs: DEFAULT_INTERVAL_SECONDS * 1000,
      log: (line) => log.line(line),
    })
    const landed = applied(await restoreOnServer(vault, wire, opts), wire)
    const report = await engine.sync()
    log.line(summarise(report))
    ctx.io.out(`restored ${landed}`)
    if (report.deferred > 0) ctx.io.out(codeHeldLine(report.deferred))
    return EXIT_OK
  } finally {
    if (engine !== null) await engine.stop()
    vault?.close()
    release()
  }
}

/**
 * The restore with the lock in somebody else's hands: on the server only. The state is read
 * beside the daemon — SQLite in WAL mode lets a reader through — to find the file's id, and
 * nothing on the disk is touched.
 */
async function restoreBesideDaemon(
  dir: string,
  wire: string,
  opts: RestoreOptions,
  ctx: CommandContext
): Promise<number> {
  const vault = await prepareVault(dir, ctx)
  try {
    const landed = applied(await restoreOnServer(vault, wire, opts), wire)
    openLog(dir).line(`restore: ${landed} restored on the server beside a running daemon`)
    ctx.io.out(`restored ${landed} on the server; the daemon will bring it down`)
    return EXIT_OK
  } finally {
    vault.close()
  }
}

/** The restore itself, whichever kind was asked for. */
function restoreOnServer(
  vault: OpenVault,
  wire: string,
  opts: RestoreOptions
): Promise<CommitOpResult> {
  return opts.deleted === undefined
    ? restoreVersion(vault, wire, opts.version)
    : undelete(vault, wire)
}

/** An old version made the head again: the one named, or the one before the head. */
async function restoreVersion(
  vault: OpenVault,
  path: string,
  versionId: string | undefined
): Promise<CommitOpResult> {
  const fileId = await fileIdFor(vault.client, vault.state, path)
  let chosen = versionId
  if (chosen === undefined) {
    const versions = await vault.client.versions(fileId, { limit: 2 })
    const previous = versions[1]
    if (previous === undefined) {
      throw new UsageError(`${path} has no earlier version to go back to`)
    }
    chosen = previous.version_id
  }
  return vault.client.restore(fileId, chosen, randomUUID())
}

/** A deleted file out of the trash, by the path it had when it went. */
async function undelete(vault: OpenVault, path: string): Promise<CommitOpResult> {
  const items = await vault.client.trash()
  const item = items.find((entry) => entry.path === path)
  if (item === undefined) throw new UsageError(`nothing deleted at ${path} is in the trash`)
  return vault.client.restoreDeleted(item.file_id, randomUUID())
}

/** Where the restore left the file, or what the server said it would not do. */
function applied(result: CommitOpResult, path: string): string {
  if (result.status === 'rejected') {
    throw new EngineError('conflict', `${path} was not restored: ${result.message}`)
  }
  return result.path
}
