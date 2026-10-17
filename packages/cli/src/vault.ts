import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  classifyFailure,
  EngineError,
  V2EngineClient,
  type HeldDelete,
  type SelectiveSettings,
  type SyncReport,
} from '@abele/sync-core'
import {
  normalisePath,
  normalizeServerUrl,
  serverUrlProblem,
  validatePath,
} from '@abele/sync-protocol'
import { readConfig, stateFolder, type DaemonConfig } from './config.js'
import {
  acquireLock,
  assertLocalSafety,
  SqliteStateStore,
  openNodeReplica,
  prepareNodeReplica,
  recoverNodeReplica,
  buildNodeEngine,
  nodeReplicaClient,
  type NodeReplica,
  type Lock,
} from '@abele/sync-node'
import { UsageError, type CommandContext } from './context.js'
import { codePluginId } from './pluginCode.js'

/**
 * The vault as every command opens it: the config, the disk, the state database and a client
 * on the device token, wired together the one way.
 *
 * `status`, `history` and `restore` open exactly what `run` does, so what they report is what
 * the daemon would do rather than an approximation of it — the same selective settings, the
 * same ignore file, the same scan filter.
 */

/** Where the daemon keeps what it has synced. */
export const stateDbFile = (dir: string): string => join(stateFolder(dir), 'state.db')

/** The vault's ignore file, beside the state folder rather than inside it. */
export const ignoreFile = (dir: string): string => join(dir, '.abele-sync-ignore')

/** The folder whose files count as scripts, matching the engine's own default. */
export const SCRIPTS_FOLDER = 'Scripts'

/** How often a daemon syncs with nothing prompting it. */
export const DEFAULT_INTERVAL_SECONDS = 300
/** The shortest interval worth asking for: below this a vault is rescanned faster than it settles. */
export const MIN_INTERVAL_SECONDS = 5

export type OpenVault = NodeReplica

/** The vault's config, or a usage error naming what has to happen first. */
export function requireConfig(dir: string): DaemonConfig {
  const cfg = readConfig(dir)
  if (cfg === null) {
    assertLocalSafety(dir)
    throw new UsageError(`${dir} is not set up: run \`abele-sync connect --dir ${dir} …\` first`)
  }
  return cfg
}

export async function prepareVault(
  dir: string,
  ctx: CommandContext,
  held?: () => boolean
): Promise<OpenVault> {
  requireServerUrl(requireConfig(dir).serverUrl)
  return prepareNodeReplica(dir, ctx, held, (path) => codePluginId(path) !== null)
}
export function openVault(dir: string, ctx: CommandContext, held?: () => boolean): OpenVault {
  return openNodeReplica({
    dir,
    config: requireConfig(dir),
    fetch: ctx.fetch,
    ...(ctx.WebSocket ? { WebSocket: ctx.WebSocket } : {}),
    ...(held ? { held } : {}),
    defer: (path) => codePluginId(path) !== null,
  })
}
export const recoverVault = recoverNodeReplica
export const buildEngine = buildNodeEngine
export type { EngineHooks } from '@abele/sync-node'

/**
 * The server address a command may send a token to, or a usage error saying why not: https,
 * or plain http to this machine only. Checked before any request, so a token (or a password)
 * never crosses a network in the clear. What comes back is the address in its one spelling
 * (`normalizeServerUrl`) — the host that was judged, and the one every request goes to.
 */
export function requireServerUrl(url: string): string {
  const problem = serverUrlProblem(url)
  if (problem !== null) throw new UsageError(`${url}: ${problem}`)
  const normal = normalizeServerUrl(url)
  if (normal === null) throw new UsageError(`${url}: the address cannot be read`)
  return normal
}

/**
 * The vault's lock, or null when another abele-sync holds it — having said so, with what to
 * do about it. Anything that takes a device's token away takes this first, so a running
 * daemon is never left syncing on a token that no longer works.
 */
export async function lockVault(
  dir: string,
  ctx: CommandContext,
  advice: string
): Promise<Lock | null> {
  try {
    return await acquireLock(dir, ctx.lockTiming)
  } catch (error) {
    if (error instanceof EngineError && error.code === 'conflict') {
      ctx.io.err(`${error.message}; ${advice}`)
      return null
    }
    throw error
  }
}

/** A client on this vault's device token. */
export function vaultClient(cfg: DaemonConfig, ctx: CommandContext): V2EngineClient {
  return nodeReplicaClient(cfg, ctx)
}

/** What to do about a token the server no longer takes, in the words every command uses. */
export const REVOKED_HINT =
  'the token was revoked or is invalid; disconnect locally and connect with a new token'

/** Whether a failure is the server refusing this device's token. */
export const isUnauthorized = (error: unknown): boolean => classifyFailure(error) === 'unauthorized'

/** The meta key under which the daemon files the line the last sync ended with. */
const LAST_SUMMARY_KEY = 'last_summary'
/** The meta key under which the daemon files the vault its state describes. */
const VAULT_KEY = 'vault'

/** Files what the sync said, so `status` can repeat it without a lock or a log. */
export function rememberSummary(vault: OpenVault, line: string): void {
  vault.state.setMeta(LAST_SUMMARY_KEY, line)
}

/** What the last sync said, or null before one has. */
export const lastSummary = (vault: OpenVault): string | null =>
  vault.state.getMeta(LAST_SUMMARY_KEY)

/** Files which vault this state describes, so a later `init --force` knows whether to keep it. */
export function rememberVault(vault: OpenVault): void {
  const binding = createHash('sha256').update(vault.cfg.deviceToken).digest('hex')
  const previous = vault.state.getMeta('token-connection')
  if (previous !== null && previous !== binding)
    throw new UsageError('connection ledger binding mismatch')
  vault.state.setMeta('token-connection', binding)
  vault.state.setMeta(VAULT_KEY, vault.cfg.vaultId)
}

/** The vault a state database was last synced with, or null when it never said. */
export const statedVault = (state: SqliteStateStore): string | null => state.getMeta(VAULT_KEY)

/** The meta key under which the daemon files the scope its last sync ran on. */
const SCOPE_KEY = 'scope'

/**
 * What this device syncs, as one short string: the selective settings and the ignore file
 * together, since a pattern dropped from `.abele-sync-ignore` widens the scope exactly as a
 * type switched on does. An absent ignore file and an empty one are told apart, harmlessly.
 */
export const scopeKey = (selective: SelectiveSettings, ignoreText: string | null): string =>
  createHash('sha256')
    .update(JSON.stringify({ selective, ignore: ignoreText }))
    .digest('hex')

/**
 * Whether the scope is not the one the last sync ran on.
 *
 * A device that widens what it syncs has passed over changes the feed will not repeat, so the
 * engine must walk the manifest again; narrowing costs the same walk for nothing, which is
 * cheap enough not to be worth telling the two apart. A state that never recorded a key has
 * never finished a sync, and its first one walks the manifest anyway.
 */
export function scopeChanged(vault: OpenVault): boolean {
  const last = vault.state.getMeta(SCOPE_KEY)
  return last !== null && last !== scopeKey(vault.cfg.selective, vault.ignoreText)
}

/** Files the scope this run synced on, so the next run knows whether it changed. */
export function rememberScope(vault: OpenVault): void {
  vault.state.setMeta(SCOPE_KEY, scopeKey(vault.cfg.selective, vault.ignoreText))
}

/** The vault's `.abele-sync-ignore` as it reads, or null when it has none. */
export function readIgnoreText(dir: string): string | null {
  try {
    return readFileSync(ignoreFile(dir), 'utf8')
  } catch {
    return null
  }
}

/** The directory a `--dir` names, absolute, so every message says where it meant. */
export const vaultDir = (dir: string): string => resolve(dir)

/** A path as the wire spells it, or a usage error saying why the vault could not hold it. */
export function wirePath(raw: string): string {
  const path = normalisePath(raw)
  try {
    validatePath(path)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  return path
}

/**
 * Which file in the vault a path names.
 *
 * The state knows it without asking the server, which is the usual case and the fast one.
 * Failing that the manifest is walked — a file this device does not sync, or has not synced
 * yet, is still the vault's — and failing that the trash, so the history of a file that was
 * deleted can still be read.
 */
export async function fileIdFor(
  client: V2EngineClient,
  state: SqliteStateStore,
  path: string
): Promise<string> {
  for await (const entry of state.all()) {
    if (entry.wirePath === path) return entry.fileId
  }
  let cursor: string | null = null
  do {
    const page = await client.manifest(cursor)
    for (const item of page.items) if (item.path === path) return item.file_id
    cursor = page.next
  } while (cursor !== null)
  for (const item of await client.trash()) if (item.path === path) return item.file_id
  throw new UsageError(`no file at ${path} in this vault`)
}

/** The held set, as a count and a short hash of its file ids, whatever order they are listed in. */
export function heldFingerprint(held: readonly HeldDelete[]): string {
  const ids = held.map((one) => one.fileId).sort()
  const hash = createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 8)
  return `${held.length}-${hash}`
}

/**
 * The deletes the guard holds, and what to do about them, as `run`, `status` and `deletes` say
 * it. A confirm is refused without the fingerprint of the set it covers, so the line carries it:
 * the command it prints is one that works, for exactly the set it was printed for (B13).
 */
export const heldLine = (dir: string, held: readonly HeldDelete[]): string =>
  `held deletes ${held.length} — abele-sync deletes --dir ${dir} --confirm --expect ` +
  `${heldFingerprint(held)} | --restore`

/** What one sync did, as the line the log and the console both take. */
export function summarise(report: SyncReport): string {
  const pulled = report.pull.applied + (report.secondPull?.applied ?? 0)
  // Changes the pull held back behind an edit here, which the next sync takes: not held deletes.
  const waiting = (report.secondPull ?? report.pull).held.length
  return (
    `sync: ${report.collisions.length ? 'partial' : 'done'} (pulled ${pulled}, pushed ${report.push.applied}, ` +
    `merged ${report.push.merged}, conflicts ${report.push.conflicts}, ` +
    `rejected ${report.push.rejected.length}, pulls waiting ${waiting}` +
    (report.collisions.length ? `, collisions ${report.collisions.length})` : ')')
  )
}

/** Bytes as a person reads them: `1.2 MB`, `934 kB`, `0 B`. */
export function humanBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0)
  return `${rounded} ${units[unit]}`
}
