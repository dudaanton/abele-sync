import { randomUUID } from 'node:crypto'
import type { CommitOpResult, TrashItem } from '@abele/sync-protocol'
import { EngineError, type SyncEngine } from '@abele/sync-core'
import { EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { acquireLock, type Lock } from '../lock.js'
import { openLog } from '../log.js'
import { promptLine } from '../prompt.js'
import { codeHeldLine } from '../pluginCode.js'
import {
  buildEngine,
  DEFAULT_INTERVAL_SECONDS,
  prepareVault,
  recoverVault,
  summarise,
  type OpenVault,
} from '../vault.js'

/**
 * `restore --deleted-since`: everything deleted since a moment, back out of the trash in one
 * commit per thousand files, then synced down under the lock as a single
 * restore is — or left to the daemon when one holds the lock.
 *
 * The moment is compared with the trash's `deleted_at`, which is the server's clock: a
 * relative one (`2h`) is taken back from this machine's clock, which is as near as the command
 * can get, so a skewed clock moves the edge by its skew and no more.
 */

export interface RestoreSinceOptions {
  deletedSince: string
  dryRun?: boolean
  yes?: boolean
}

/** Past this many files, a person is asked first, or `--yes` has to say so. */
const ASK_ABOVE = 20
/** How many paths a confirmation shows before it says how many more. */
const SHOWN = 20

export async function runRestoreSince(
  dir: string,
  opts: RestoreSinceOptions,
  ctx: CommandContext
): Promise<number> {
  const since = parseSince(opts.deletedSince, Date.now())
  let release: Lock | null = null
  try {
    release = await acquireLock(dir)
  } catch (error) {
    if (!(error instanceof EngineError && error.code === 'conflict')) throw error
  }
  let vault: OpenVault | null = null
  let engine: SyncEngine | null = null
  try {
    vault = await prepareVault(dir, ctx, release?.held)
    if (release !== null) await recoverVault(vault, release.held)
    const items = (await vault.client.trash())
      .filter((item) => Date.parse(item.deleted_at) >= since)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const edge = new Date(since).toISOString()
    if (items.length === 0) {
      ctx.io.out(`nothing deleted since ${edge} is in the trash`)
      return EXIT_OK
    }
    if (opts.dryRun === true) {
      ctx.io.out(`${items.length} files in the trash were deleted since ${edge}`)
      for (const item of items) ctx.io.out(`  ${describe(item)}`)
      return EXIT_OK
    }
    if (items.length > ASK_ABOVE && opts.yes !== true) await ask(items, edge, ctx)

    const results = await vault.client.restoreDeletedMany(
      items.map((item) => item.file_id),
      randomUUID()
    )
    const log = openLog(dir)
    for (const line of report(items, results)) ctx.io.out(line)
    log.line(`restore: ${items.length} files deleted since ${edge} put back from the trash`)

    if (release === null) {
      ctx.io.out('the daemon will bring them down')
      return EXIT_OK
    }
    engine = buildEngine(vault, {
      stillHeld: release.held,
      fallbackMs: DEFAULT_INTERVAL_SECONDS * 1000,
      log: (line) => log.line(line),
    })
    const synced = await engine.sync()
    log.line(summarise(synced))
    if (synced.deferred > 0) ctx.io.out(codeHeldLine(synced.deferred))
    return EXIT_OK
  } finally {
    if (engine !== null) await engine.stop()
    vault?.close()
    release?.()
  }
}

/**
 * The moment `--deleted-since` names, in ms: an ISO-8601 time, or an amount of minutes, hours
 * or days before `now`.
 */
export function parseSince(raw: string, now: number): number {
  const ago = /^(\d+)\s*([mhd])$/.exec(raw.trim())
  if (ago !== null) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2] as 'm' | 'h' | 'd']
    return now - Number(ago[1]) * unit
  }
  // A date alone is taken as UTC midnight, as `Date.parse` does; anything else must be ISO.
  const at = /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : Number.NaN
  if (Number.isNaN(at)) {
    throw new UsageError(
      `--deleted-since takes an ISO time or an amount ago (30m, 2h, 1d), not ${raw}`
    )
  }
  return at
}

/** A trashed file in a line: its path, when it went, and who deleted it where the server says. */
function describe(item: TrashItem): string {
  const by =
    item.deleted_by === undefined || item.deleted_by === null ? '' : `, by ${item.deleted_by.name}`
  return `${item.path}  (deleted ${item.deleted_at}${by})`
}

/** Ask at a terminal before restoring many files; a script is told to say `--yes`. */
async function ask(items: TrashItem[], edge: string, ctx: CommandContext): Promise<void> {
  const { stdin, stderr } = ctx.io
  if (stdin?.isTTY !== true || stderr === undefined) {
    throw new UsageError(
      `${items.length} files; add --yes to restore them, or --dry-run to see which`
    )
  }
  const shown = items.slice(0, SHOWN).map((item) => `  ${item.path}\n`)
  const more = items.length > SHOWN ? `  and ${items.length - SHOWN} more\n` : ''
  const answer = await promptLine(
    stdin,
    stderr,
    `${items.length} files deleted since ${edge} will come back:\n${shown.join('')}${more}` +
      'Restore them? [y/N] ',
    'no answer: add --yes to restore them'
  )
  if (answer !== 'y' && answer !== 'yes') throw new UsageError('nothing restored')
}

/** How it went: a count line, then one line for each file that came back elsewhere or not at all. */
function report(items: TrashItem[], results: CommitOpResult[]): string[] {
  const lines: string[] = []
  let restored = 0
  let renamed = 0
  let failed = 0
  items.forEach((item, at) => {
    const result = results[at]
    if (result === undefined || result.status === 'rejected') {
      failed++
      // `not_found` is a file out of the trash already — restored by an earlier try whose answer
      // was lost, or by someone else — rather than one that failed to come back.
      lines.push(
        result?.status === 'rejected' && result.code === 'not_found'
          ? `  ${item.path}: not in the trash any more`
          : `  ${item.path}: not restored: ${result?.message ?? 'no answer'}`
      )
      return
    }
    restored++
    if (result.path !== item.path) {
      renamed++
      lines.push(`  ${item.path} came back as ${result.path}`)
    }
  })
  return [`restored ${restored}; ${renamed} came back under a new name; ${failed} failed`, ...lines]
}
