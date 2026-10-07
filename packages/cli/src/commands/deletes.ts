import {
  EngineError,
  fileDeleteDecision,
  readHeldDeletes,
  type DeleteDecision,
  type HeldDelete,
} from '@abele/sync-core'
import { EXIT_LOCKED, EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { acquireLock, localDaemon, lockHolder } from '../lock.js'
import { promptLine } from '../prompt.js'
import { openLog } from '../log.js'
import { heldFingerprint, openVault, requireConfig, vaultDir } from '../vault.js'

/**
 * The deletes the guard is holding, and the decision about them.
 *
 * With no flag, the held deletes are listed, with a fingerprint of the set. `--confirm` files
 * the decision to send them and `--restore` the decision to bring the files back from the
 * server; either is carried out by the next sync, which is the engine's to run under the
 * vault's lock. A confirm sends files to every device's trash, so it covers exactly the set the
 * person read: `--expect` names that set's fingerprint, and a set that changed since is refused;
 * at a terminal the list is shown and asked about instead.
 *
 * The command writes the decision and nothing else, so it may run beside a daemon on this
 * machine: SQLite takes the one write beside the daemon's, and the daemon is asked with
 * `SIGUSR1` to sync now rather than at its next interval. Beside one on another machine it
 * refuses: a SQLite database in WAL mode is not written from two hosts (item 4). With no
 * daemon, the lock is taken for the write, so no `run` starting meanwhile reads half of it, and
 * the next `run` carries it out.
 */

export interface DeletesOptions {
  dir: string
  confirm?: boolean
  restore?: boolean
  /** The fingerprint `deletes` listed the held set under; `--confirm` sends only that set. */
  expect?: string
}

/** How many paths a terminal confirm shows before "and N more". */
const SHOWN = 20

export async function runDeletes(opts: DeletesOptions, ctx: CommandContext): Promise<number> {
  if (opts.confirm === true && opts.restore === true) {
    throw new UsageError('--confirm and --restore are two different decisions: choose one')
  }
  const dir = vaultDir(opts.dir)
  requireConfig(dir)
  const kind: DeleteDecision['kind'] | null =
    opts.confirm === true ? 'confirm' : opts.restore === true ? 'restore' : null

  if (kind === null) return list(dir, ctx)

  if (opts.expect !== undefined && kind !== 'confirm') {
    throw new UsageError('--expect goes with --confirm')
  }
  let release: (() => void) | null = null
  try {
    release = await acquireLock(dir, ctx.lockTiming ?? {})
  } catch (error) {
    if (!(error instanceof EngineError && error.code === 'conflict')) throw error
    const holder = lockHolder(dir)
    if (holder !== null && !holder.here) {
      ctx.io.err(
        `the daemon holding ${dir} runs on ${holder.host ?? 'another machine'}; ` +
          'decide there, where its state database is local'
      )
      return EXIT_LOCKED
    }
  }
  try {
    const vault = openVault(dir, ctx)
    let count: number
    try {
      const held = await readHeldDeletes(vault.state)
      count = held.length
      if (count === 0) {
        ctx.io.out('no deletions held; nothing to decide')
        return EXIT_OK
      }
      if (kind === 'confirm') await agreed(held, opts.expect, dir, ctx)
      await fileDeleteDecision(vault.state, {
        kind,
        fileIds: held.map((one) => one.fileId),
        at: new Date().toISOString(),
      })
    } finally {
      vault.close()
    }
    const what =
      kind === 'confirm'
        ? `${count} deletions will be sent at the next sync`
        : `${count} files will come back at the next sync`
    openLog(dir).line(`deletes: ${kind} filed for ${count} held deletions`)
    if (release !== null) {
      ctx.io.out(`${what}: run \`abele-sync run --dir ${dir}\``)
      return EXIT_OK
    }
    ctx.io.out(`${what}; ${poke(dir)}`)
    return EXIT_OK
  } finally {
    release?.()
  }
}

/** The held deletes, one path a line under a count. */
async function list(dir: string, ctx: CommandContext): Promise<number> {
  const vault = openVault(dir, ctx)
  try {
    const held = await readHeldDeletes(vault.state)
    if (held.length === 0) {
      ctx.io.out('no deletions held')
      return EXIT_OK
    }
    ctx.io.out(`${held.length} deletions held`)
    for (const one of held) ctx.io.out(`  ${one.path}`)
    ctx.io.out(
      `decide with: abele-sync deletes --dir ${dir} --confirm --expect ${heldFingerprint(held)}` +
        ' | --restore'
    )
    return EXIT_OK
  } finally {
    vault.close()
  }
}

/**
 * Whether the held set is the one the person agreed to send: the one `--expect` names, or, at a
 * terminal with no `--expect`, the one just shown and answered yes to. A script is told to pass
 * the fingerprint `deletes` lists.
 */
async function agreed(
  held: HeldDelete[],
  expect: string | undefined,
  dir: string,
  ctx: CommandContext
): Promise<void> {
  const now = heldFingerprint(held)
  if (expect !== undefined) {
    if (expect.trim() === now) return
    throw new UsageError(
      `the held deletions changed since they were listed (${expect}, now ${now}): ` +
        `list them again with abele-sync deletes --dir ${dir}`
    )
  }
  const { stdin, stderr } = ctx.io
  if (stdin?.isTTY !== true || stderr === undefined) {
    throw new UsageError(
      `list them with abele-sync deletes --dir ${dir}, then confirm that list with --expect ${now}`
    )
  }
  const shown = held.slice(0, SHOWN).map((one) => `  ${one.path}\n`)
  const more = held.length > SHOWN ? `  and ${held.length - SHOWN} more\n` : ''
  const answer = await promptLine(
    stdin,
    stderr,
    `${held.length} files will go to the trash on every device:\n${shown.join('')}${more}` +
      'Send these deletions? [y/N] ',
    `no answer: confirm with --expect ${now}`
  )
  if (answer !== 'y' && answer !== 'yes') throw new UsageError('nothing decided')
}

/**
 * Ask the daemon holding the lock to sync now, and say what came of it. Only a daemon `run` on
 * this machine is signalled (`localDaemon`). Any other holder — a `run --once`, a `restore`, a
 * `join`, or a lock gone between the two reads — is no daemon and has no `--interval`: the next
 * sync takes the decision, whoever runs it.
 */
function poke(dir: string): string {
  const pid = localDaemon(dir)
  if (pid === null) return 'what holds the lock now is no daemon run; the next sync takes it'
  try {
    process.kill(pid, 'SIGUSR1')
    return 'the running daemon was asked to sync now'
  } catch {
    /* gone meanwhile, or not ours to signal: it takes the decision when it next syncs */
  }
  return 'the running daemon applies it at its next sync (within --interval)'
}
