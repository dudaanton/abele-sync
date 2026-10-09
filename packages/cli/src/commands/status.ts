import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readHeldDeletes,
  readStaged,
  scan,
  type CaseCollision,
  type ScanFilter,
} from '@abele/sync-core'
import { codeGroups, codeHeldLine, codeText } from '../pluginCode.js'
import { stateFolder } from '../config.js'
import { EXIT_FAILED, EXIT_OK, type CommandContext } from '../context.js'
import { localDaemon } from '../lock.js'
import { liveCount } from '../progress.js'
import { personalRevocationBinding, wasRevoked } from '../revoked.js'
import {
  heldLine,
  humanBytes,
  isUnauthorized,
  lastSummary,
  prepareVault,
  REVOKED_HINT,
  vaultDir,
} from '../vault.js'

/**
 * Where this vault stands: what the state remembers, what the server holds, and what the log
 * says happened last.
 *
 * Nothing here takes the lock. A daemon is usually running while somebody asks, and the two
 * do not get in each other's way: SQLite is in WAL mode, so the read goes through beside the
 * daemon's writes, and the scan only reads the disk. The count it prints is what a sync would
 * push this second, which is the number a person actually wants — not one the daemon left
 * behind in a status field. Nothing here sweeps the temp folder either: what is in it may be
 * the daemon's download in progress.
 */

export interface StatusOptions {
  dir: string
}

/** How many of the server's refusals the tail of the log is searched for. */
const REFUSALS_SHOWN = 5

export async function runStatus(opts: StatusOptions, ctx: CommandContext): Promise<number> {
  const dir = vaultDir(opts.dir)
  const vault = await prepareVault(dir, ctx)
  try {
    if (wasRevoked(vault.state, personalRevocationBinding(vault.cfg))) {
      ctx.io.out('state      revoked')
      ctx.io.out(REVOKED_HINT)
      return EXIT_OK
    }
    const cursor = await vault.state.getCursor()
    // The approval queue is local: show it even if the following server request is offline.
    const groups = codeGroups(await readStaged(vault.state))
    if (groups.length > 0) {
      ctx.io.out(codeHeldLine(groups.reduce((n, group) => n + group.changes.length, 0)))
      for (const group of groups) ctx.io.out(`plugin     ${codeText(group.ids.join(', '))}`)
    }
    let state
    try {
      state = await vault.client.state()
    } catch (error) {
      if (!isUnauthorized(error)) throw error
      ctx.io.err(error instanceof Error ? error.message : String(error))
      ctx.io.err(REVOKED_HINT)
      return EXIT_FAILED
    }
    // The same filter `run` scans with: the vault's own cap, learned from the state, on top of
    // this device's — or a file over it would read as pending here and as nothing there.
    const cap = state.settings.max_file_bytes
    const filter: ScanFilter = {
      excluded: (path, size) => size > cap || vault.filter.excluded(path, size),
    }
    const found = await scan(vault.fs, vault.state, filter)
    // What the guard holds is waiting for a person, not for the next sync.
    const held = await readHeldDeletes(vault.state)
    const holding = new Set(held.map((one) => one.fileId))
    const pending = found.ops.filter((op) => op.op !== 'delete' || !holding.has(op.file_id))
    const usage = await vault.client.usage()
    const tail = readLogTail(dir)

    const say = (label: string, value: string): void => {
      ctx.io.out(`${label.padEnd(10)} ${value}`)
    }
    say('vault', `${vault.cfg.vaultId} at ${vault.cfg.serverUrl}`)
    say('device', `${vault.cfg.deviceName} (${vault.cfg.deviceId})`)
    say('cursor', String(cursor))
    say('head_seq', String(state.head_seq))
    // A daemon's push in flight is counted down by the daemon: the state learns a file is
    // through only once its batch is recorded, so until then the scan still counts it (B14).
    const pushing = liveCount(dir, localDaemon)
    say('pending', pushing === null ? String(pending.length) : `${pushing} (the daemon is pushing)`)
    if (held.length > 0) ctx.io.out(heldLine(dir, held))
    if (vault.cfg.joinPrefer !== undefined) {
      const side = vault.cfg.joinPrefer === 'mine' ? 'this folder' : 'the server'
      say('joining', `${side} wins where both hold a file, until the first sync is done`)
    }
    say('last sync', tail.lastSyncAt ?? 'never')
    say('summary', lastSummary(vault) ?? 'none')
    say('last error', tail.lastError ?? 'none')
    for (const line of tail.refused) say('refused', line)
    for (const collision of found.collisions) say('held', collisionLine(collision))
    say(
      'usage',
      `live ${humanBytes(usage.live_bytes)}, history ${humanBytes(usage.history_bytes)}, ` +
        `trash ${humanBytes(usage.trash_bytes)}`
    )
    return EXIT_OK
  } finally {
    vault.close()
  }
}

/** A file the scan holds back, and what to do about it, in one line. */
export const collisionLine = ({ path, with: synced }: CaseCollision): string =>
  `${path}: ${synced} is synced under the same name but for case; rename one of them`

interface LogTail {
  lastSyncAt: string | null
  lastError: string | null
  /** The last few ops the server refused, newest last, as the log had them. */
  refused: string[]
}

/**
 * The last thing the log has to say about syncing: when a sync last got through, what went
 * wrong since — a failure before the last good sync has been got over already and is not
 * worth alarming anybody with — and the last few ops the server refused, which a good sync
 * does not get over: a refused file is refused again on every sync until it changes.
 */
export function readLogTail(dir: string): LogTail {
  let text: string
  try {
    text = readFileSync(join(stateFolder(dir), 'log'), 'utf8')
  } catch {
    return { lastSyncAt: null, lastError: null, refused: [] }
  }
  const lines = text.split('\n')
  let lastSyncAt: string | null = null
  let lastError: string | null = null
  const refused: string[] = []
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (refused.length < REFUSALS_SHOWN && /push: \S+ refused: /.test(line)) {
      refused.unshift(line.replace(/^\S+ /, ''))
    }
    if (lastSyncAt !== null) continue
    if (line.includes('sync: done')) {
      lastSyncAt = timestampOf(line)
      continue
    }
    const failure = /sync:? failed: (.+)$/.exec(line)
    if (failure && lastError === null) lastError = failure[1]!
  }
  return { lastSyncAt, lastError, refused }
}

/** The ISO stamp `openLog` puts at the front of every line. */
function timestampOf(line: string): string | null {
  const stamp = /^(\S+)/.exec(line)
  return stamp === null ? null : stamp[1]!
}
