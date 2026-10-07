/**
 * What every command is handed, and the codes they answer with.
 *
 * The program is a function of its arguments, its environment and this: nothing under
 * `commands/` reaches for `process`, `console`, the global `fetch` or a real socket, so a
 * test drives the whole daemon on fakes and reads back every line it printed.
 */

/** What a prompt reads from: a stream, and whether a person is at the other end of it. */
export interface PromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean
}

export interface CliIo {
  out(line: string): void
  err(line: string): void
  /** The transport every request goes through; the global one in production. */
  fetch?: typeof fetch
  /** What the event stream is opened with; the global one in production. */
  WebSocket?: typeof WebSocket
  /** Where a prompt reads its answer; `process.stdin` in production, absent on a fake. */
  stdin?: PromptInput
  /** Where a prompt is written; `process.stderr` in production, so `out` stays parseable. */
  stderr?: NodeJS.WritableStream
  /** How long a revoke may take before it counts as unreachable; `REVOKE_TIMEOUT_MS` unless a test shortens it. */
  revokeTimeoutMs?: number
  /** How often the daemon beats its lock and how long a lock is watched; a test shortens both. */
  lockTiming?: { heartbeatMs: number; watchMs: number }
  /** How often the daemon files and says what is left of a push; a test shortens both. */
  progressTiming?: { fileMs: number; lineMs: number }
}

export interface CommandContext {
  io: CliIo
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
  WebSocket?: typeof WebSocket
  /** How long telling a server a device is leaving may take. */
  revokeTimeoutMs: number
  /** The lock's beat and watch, when not the defaults. */
  lockTiming?: { heartbeatMs: number; watchMs: number }
  /** How often the daemon files and says what is left of a push, when not the defaults. */
  progressTiming?: { fileMs: number; lineMs: number }
}

/**
 * How long a revoke may take. A server that drops packets would otherwise hold `disconnect`
 * — and the vault's lock with it — or `init --force` after it has already succeeded, forever.
 */
export const REVOKE_TIMEOUT_MS = 10_000

/** All went well. */
export const EXIT_OK = 0
/** The server, the disk or the vault said no; the message is on `err`. */
export const EXIT_FAILED = 1
/** The command line was wrong, or the vault is not in the state the command needs. */
export const EXIT_USAGE = 2
/** Another abele-sync holds this vault. */
export const EXIT_LOCKED = 3
/** The credential was revoked/expired/refused; no retry can restore its authority. */
export const EXIT_REVOKED = 4

/** Docker cannot exclude one nonzero status from on-failure. An explicit environment
 * opt-in maps terminal revocation to 0; ordinary crashes stay nonzero.
 */
export function processExitCode(code: number, env: NodeJS.ProcessEnv): number {
  return code === EXIT_REVOKED && env.ABELE_REVOKED_EXIT_ZERO === '1' ? EXIT_OK : code
}

/**
 * A mistake in what was asked for, rather than a failure carrying it out: an option that was
 * not given, a vault that was set up already, a vault that never was.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}
