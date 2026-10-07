import { Command, CommanderError } from 'commander'
import {
  runAgentSetup,
  runAgentRun,
  type AgentSetupOptions,
  type AgentRunOptions,
} from './commands/agent.js'
import { runDisconnect, type DisconnectOptions } from './commands/disconnect.js'
import {
  runAgentStatus,
  runAgentHistory,
  runAgentTrash,
  runAgentRestore,
  runAgentDeletes,
  runAgentDisconnect,
  type AgentMaintenanceOptions,
} from './commands/agentMaintenance.js'
import { runCode, type CodeOptions } from './commands/code.js'
import { runDeletes, type DeletesOptions } from './commands/deletes.js'
import { runHistory, type HistoryOptions } from './commands/history.js'
import { runInit, type InitOptions } from './commands/init.js'
import { runRestore, type RestoreOptions } from './commands/restore.js'
import { runRun, type RunOptions } from './commands/run.js'
import { runStatus, type StatusOptions } from './commands/status.js'
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  REVOKE_TIMEOUT_MS,
  UsageError,
  type CliIo,
  type CommandContext,
} from './context.js'

export const CLI_NAME = 'abele-sync'

/**
 * The program, as a function.
 *
 * `runCli` takes the arguments, the environment and everything that talks to the outside
 * world, and answers with the exit code — nothing here calls `process.exit`, writes to a
 * console or reaches for a global `fetch`, which is what lets a test drive the whole daemon
 * and read back every line it printed. `src/index.ts` is the shell around it.
 *
 * The codes are the ones a script can act on: 0 for done, 1 for a server or a disk that said
 * no, 2 for a command line or a vault that was not what the command needed, 3 for a vault
 * another abele-sync is already syncing, 4 for a daemon's revoked credential.
 */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const ctx: CommandContext = {
    io,
    env,
    fetch: io.fetch ?? globalThis.fetch,
    WebSocket: io.WebSocket ?? globalThis.WebSocket,
    revokeTimeoutMs: io.revokeTimeoutMs ?? REVOKE_TIMEOUT_MS,
    ...(io.lockTiming === undefined ? {} : { lockTiming: io.lockTiming }),
    ...(io.progressTiming === undefined ? {} : { progressTiming: io.progressTiming }),
  }
  const chosen: { run: (() => Promise<number>) | null } = { run: null }
  const program = buildProgram(io, ctx, chosen)

  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` is commander leaving early, not a mistake; anything else it refused is one,
      // and it has already said so through `configureOutput`.
      if (error.exitCode === 0) return EXIT_OK
      if (error.code === 'commander.unknownCommand') io.err(usage(program))
      return EXIT_USAGE
    }
    return fail(io, error)
  }

  if (chosen.run === null) {
    io.err(usage(program))
    return EXIT_USAGE
  }
  try {
    return await chosen.run()
  } catch (error) {
    return fail(io, error)
  }
}

function buildProgram(
  io: CliIo,
  ctx: CommandContext,
  chosen: { run: (() => Promise<number>) | null }
): Command {
  const program = new Command()
  program
    .name(CLI_NAME)
    .description('sync an Obsidian vault with an abele server')
    // A CLI that is also a function must not take the process down with it.
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.out(s.replace(/\n$/, '')),
      writeErr: (s) => io.err(s.replace(/\n$/, '')),
    })

  program
    .command('init')
    .description('set this directory up as a vault on a server')
    .requiredOption('--server <url>', 'where the server lives')
    .requiredOption('--dir <dir>', 'the vault directory')
    .requiredOption('--email <email>', 'the account to log in as')
    .option(
      '--password <password>',
      'its password — other users can read it from ps; prefer ABELE_PASSWORD in the environment'
    )
    .option('--vault <name>', 'which vault to sync with, or the name of the one to create')
    .option('--device-name <name>', 'what to call this device; the hostname by default')
    .option(
      '--force',
      'set up again over an existing config, revoking the device it replaces and keeping the state only if the vault is the same'
    )
    .option(
      '--prefer <side>',
      'where this folder and the vault both hold a file, which one is kept: merge (both, the default), local or server; asked at a terminal when it matters'
    )
    .action((opts: InitOptions) => {
      chosen.run = () => runInit(opts, ctx)
    })

  program
    .command('run')
    .description('sync this vault, once or until stopped')
    .requiredOption('--dir <dir>', 'the vault directory')
    .option('--once', 'sync once and exit')
    .option(
      '--interval <seconds>',
      'how often to sync when nothing else prompts it; at least 5',
      '300'
    )
    .action((opts: RunOptions) => {
      chosen.run = () => runRun(opts, ctx)
    })

  program
    .command('disconnect')
    .description('revoke this device on the server and remove its config; the state stays')
    .requiredOption('--dir <dir>', 'the vault directory')
    .option(
      '--force',
      'forget the device here even when the server cannot be told; it stays enrolled there'
    )
    .action((opts: DisconnectOptions) => {
      chosen.run = () => runDisconnect(opts, ctx)
    })

  program
    .command('status')
    .description('where this vault stands')
    .requiredOption('--dir <dir>', 'the vault directory')
    .action((opts: StatusOptions) => {
      chosen.run = () => runStatus(opts, ctx)
    })

  program
    .command('history')
    .description("one file's versions, newest first")
    .argument('<path>', 'the file, as the vault spells it')
    .requiredOption('--dir <dir>', 'the vault directory')
    .option('--diff <versions...>', 'two versions to compare, by id or by number')
    .action((path: string, opts: HistoryOptions) => {
      chosen.run = () => runHistory(path, opts, ctx)
    })

  program
    .command('restore')
    .description('put back a version of a file, or a file that was deleted')
    .argument('[path]', 'the file, as the vault spells it')
    .requiredOption('--dir <dir>', 'the vault directory')
    .option('--version <id>', 'the version to go back to; the one before the head by default')
    .option('--deleted [path]', 'bring a deleted file back instead')
    .option(
      '--deleted-since <when>',
      'bring back every file deleted since then: an ISO time (a date alone is UTC midnight, a time with no zone is local), or 30m, 2h, 1d ago'
    )
    .option('--dry-run', 'with --deleted-since: list what would come back, and restore nothing')
    .option('--yes', 'with --deleted-since: restore more than 20 files without asking')
    .action((path: string | undefined, opts: RestoreOptions) => {
      chosen.run = () => runRestore(path, opts, ctx)
    })

  program
    .command('deletes')
    .description('the deletions held because a sync would remove many files at once')
    .requiredOption('--dir <dir>', 'the vault directory')
    .option('--confirm', 'send them: the files go to the trash on every device')
    .option('--restore', 'put the files back here from the server')
    .option(
      '--expect <fingerprint>',
      'with --confirm: the fingerprint the list printed, so only that set is sent'
    )
    .action((opts: DeletesOptions) => {
      chosen.run = () => runDeletes(opts, ctx)
    })

  program
    .command('code')
    .description('list plugin code awaiting approval, or approve/reject one listed plugin group')
    .requiredOption('--dir <dir>', 'the vault directory')
    .option('--approve <plugins...>', 'install exactly the staged code shown for these plugins')
    .option('--reject <plugins...>', 'keep local code instead of these staged changes')
    .option(
      '--expect <fingerprint>',
      'the fingerprint printed by code; required for either decision'
    )
    .action((opts: CodeOptions) => {
      chosen.run = () => runCode(opts, ctx)
    })

  const agent = program
    .command('agent')
    .description('single Agents/ folder-scoped daemon; no personal token or publisher')
  agent
    .command('setup')
    .requiredOption('--server <url>', 'scoped issuer')
    .requiredOption('--dir <dir>', 'fresh dedicated vault root')
    .requiredOption('--vault <id>', 'remote vault identity')
    .requiredOption('--grant <id>', 'folder grant identity')
    .requiredOption('--principal <id>', 'machine key identity')
    .action((opts: AgentSetupOptions) => {
      chosen.run = () => runAgentSetup(opts, ctx)
    })
  agent
    .command('run')
    .requiredOption('--dir <dir>', 'dedicated vault root')
    .option('--once', 'one polling cycle')
    .option('--interval <seconds>', 'polling interval, at least 5 seconds', '30')
    .action((opts: AgentRunOptions) => {
      chosen.run = () => runAgentRun(opts, ctx)
    })
  agent
    .command('status')
    .description('read a local committed ledger snapshot, including beside a running agent')
    .requiredOption('--dir <dir>', 'agent vault root')
    .action((opts: AgentMaintenanceOptions) => {
      chosen.run = () => runAgentStatus(opts, ctx)
    })
  agent
    .command('history')
    .argument('<path>', 'received scoped path')
    .requiredOption('--dir <dir>', 'agent vault root')
    .option('--cursor <opaque>', 'continue the displayed scoped history page')
    .action((path: string, opts: AgentMaintenanceOptions) => {
      chosen.run = () => runAgentHistory(path, opts, ctx)
    })
  agent
    .command('trash')
    .requiredOption('--dir <dir>', 'agent vault root')
    .option('--cursor <opaque>', 'continue the displayed scoped trash page')
    .action((opts: AgentMaintenanceOptions) => {
      chosen.run = () => runAgentTrash(opts, ctx)
    })
  agent
    .command('restore')
    .argument('<path>', 'received or scoped-trash path')
    .requiredOption('--dir <dir>', 'agent vault root')
    .requiredOption('--version <id>', 'exact authorized displayed version')
    .action((path: string, opts: AgentMaintenanceOptions) => {
      chosen.run = () => runAgentRestore(path, opts, ctx)
    })
  agent
    .command('deletes')
    .requiredOption('--dir <dir>', 'agent vault root')
    .option('--confirm', 'send the exact displayed missing-file set')
    .option('--expect <fingerprint>', 'displayed delete-set fingerprint')
    .action((opts: AgentMaintenanceOptions) => {
      chosen.run = () => runAgentDeletes(opts, ctx)
    })
  agent
    .command('disconnect')
    .requiredOption('--dir <dir>', 'agent vault root')
    .option('--force', 'forget locally if self-revoke is unreachable; retain data/state')
    .action((opts: AgentMaintenanceOptions) => {
      chosen.run = () => runAgentDisconnect(opts, ctx)
    })
  return program
}

/** What went wrong, in one line, and the code that says how badly. */
function fail(io: CliIo, error: unknown): number {
  io.err(oneLine(error instanceof Error ? error.message : String(error)))
  return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED
}

/**
 * A message as one line of plain text. A server's words are printed as they came, bar what a
 * terminal would obey rather than show: control characters go, and a line break becomes a space,
 * so nothing a server sends can draw a second line that looks like ours.
 */
export function oneLine(message: string): string {
  return message.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

const usage = (program: Command): string => program.helpInformation().replace(/\n$/, '')
