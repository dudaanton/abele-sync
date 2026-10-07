import {
  IgnoreRules,
  isExcluded,
  isHidden,
  joinFinished,
  type SelectiveSettings,
  type SyncReport,
} from '@abele/sync-core'
import { normalisePath, validatePath, type JoinPrefer, type VaultInfo } from '@abele/sync-protocol'
import { readConfig, writeConfig } from './config.js'
import { UsageError, type CommandContext } from './context.js'
import { NodeFileSystem } from './nodeFs.js'
import { promptLine } from './prompt.js'
import { readIgnoreText, SCRIPTS_FOLDER } from './vault.js'

/**
 * Which side wins where a folder and the vault it joins both hold a file.
 *
 * `init` asks only when the answer matters: the folder has files the daemon would sync, the
 * vault has live files, and the folder's state does not already describe that vault, walked to
 * the end — a folder set up again on its own vault picks up where it left off, and a new vault
 * has nothing to lose. `init --force` over a join that had not finished keeps its choice.
 * At a terminal it asks; in a script it refuses until `--prefer` says, because guessing here is
 * guessing whose copy of a file becomes the head.
 *
 * The answer the engine takes is `mine` or `theirs`; "merge both" is no preference at all.
 */

/** What `--prefer` takes, and what each means to the engine. */
const CHOICES: Record<string, JoinPrefer | null> = { merge: null, local: 'mine', server: 'theirs' }

/** The engine's preference for a `--prefer` value: null for merge, or a usage error. */
export function parsePrefer(raw: string): JoinPrefer | null {
  const choice = CHOICES[raw]
  if (choice === undefined) {
    throw new UsageError(`--prefer takes merge, local or server, not ${raw}`)
  }
  return choice
}

/** What `init` knows when it decides whether to ask. */
export interface JoinFacts {
  dir: string
  /** The vault joined, or null when `init` has just made it. */
  vault: VaultInfo | null
  vaultName: string
  /** Whether the folder's state already describes this very vault, walked to the end. */
  keptLedger: boolean
  /** The choice of a join on this very vault that `init --force` replaces before it finished. */
  unfinished?: JoinPrefer
  selective: SelectiveSettings
  /** `--prefer` as given, parsed; undefined when it was not. */
  given: JoinPrefer | null | undefined
}

/**
 * The preference to write into the config: the one given, or the one asked for — or null,
 * which is "merge both", and also what a join with nothing to decide gets.
 */
export async function joinPrefer(
  facts: JoinFacts,
  ctx: CommandContext
): Promise<JoinPrefer | null> {
  // Nothing to decide: say so to whoever passed --prefer, rather than taking it without a word.
  const moot = (why: string): null => {
    if (facts.given !== undefined) ctx.io.out(`--prefer not needed: ${why}; nothing to decide`)
    return null
  }
  if (facts.vault === null) return moot('the vault is new')
  if (facts.keptLedger) return moot('this folder picks up where it left off on this vault')
  if (facts.unfinished !== undefined && facts.given === undefined) return facts.unfinished
  const remote = liveFiles(facts.vault)
  if (remote === 0) return moot('the vault has no files')
  const local = await filesInScope(facts.dir, facts.selective)
  if (local === 0) return moot('this folder has no files to sync')
  if (facts.given !== undefined) return facts.given

  const both = `this folder and vault ${facts.vaultName} both hold files (${local} here, ${remote} on the server)`
  const { stdin, stderr } = ctx.io
  if (stdin?.isTTY !== true || stderr === undefined) {
    throw new UsageError(`${both}; choose --prefer merge, local or server`)
  }
  const answer = await promptLine(
    stdin,
    stderr,
    `${both}.\n` +
      'Where both have a file, which one is kept? The other is kept in version history.\n' +
      '  merge   notes keep both texts, other files the newer one (the default)\n' +
      "  local   this folder's\n" +
      "  server  the server's\n" +
      'merge, local or server? ',
    'no answer: choose --prefer merge, local or server'
  )
  return parsePrefer(answer === '' ? 'merge' : answer)
}

/**
 * After a sync: once it has finished the join (`joinFinished`), the preference leaves the
 * config, so no later process sends it again. True when it did so just now. The config is read
 * again rather than trusted from the start of the run, and rewritten whole, under the vault's
 * lock that `run` holds.
 */
export function forgetJoinOnceDone(dir: string, report: SyncReport): boolean {
  if (!joinFinished(report)) return false
  const cfg = readConfig(dir)
  if (cfg?.joinPrefer === undefined) return false
  const { joinPrefer: _done, ...rest } = cfg
  writeConfig(dir, rest)
  return true
}

/** The vault's live files, of every kind. */
const liveFiles = (vault: VaultInfo): number =>
  Object.values(vault.usage.by_kind).reduce((sum, kind) => sum + (kind?.count ?? 0), 0)

/**
 * How many files in the folder the daemon would sync: what `run` walks, less what the hidden
 * rule, the ignore file and the selective settings pass over. Nothing is read or hashed.
 */
export async function filesInScope(dir: string, selective: SelectiveSettings): Promise<number> {
  const disk = new NodeFileSystem(dir, { skipHidden: true })
  const text = readIgnoreText(dir)
  const rules = text === null ? null : IgnoreRules.parse(text)
  let count = 0
  for await (const info of disk.list()) {
    let wire: string
    try {
      wire = normalisePath(info.path)
      validatePath(wire)
    } catch {
      continue
    }
    if (isHidden(wire) || (rules?.ignores(wire) ?? false)) continue
    if (isExcluded(wire, info.size, selective, SCRIPTS_FOLDER)) continue
    count++
  }
  return count
}
