import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  classifyFailure,
  EngineError,
  ExpectedWrites,
  resumeJournal,
  recoverPendingPullWrites,
  StagedChanges,
  IgnoreRules,
  isExcluded,
  isHidden,
  SyncClient,
  SyncEngine,
  type FileSystem,
  type HeldDelete,
  type PathMatcher,
  type ScanFilter,
  type SelectiveSettings,
  type SyncFailure,
  type SyncReport,
  type VaultClient,
  type RecoveryBarrier,
} from '@abele/sync-core'
import {
  normalisePath,
  normalizeServerUrl,
  serverUrlProblem,
  validatePath,
} from '@abele/sync-protocol'
import { readConfig, stateFolder, type DaemonConfig } from './config.js'
import { acquireLock, type Lock } from './lock.js'
import { assertLocalSafety, EffectFence, personalStamp } from './externalSafety.js'
import { CodeGroupDisk } from './codeGroupDisk.js'
import { anyOf, SettlingFileSystem } from './growing.js'
import { NodeFileSystem } from './nodeFs.js'
import { SqliteStateStore } from './sqliteState.js'
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

export interface OpenVault {
  dir: string
  cfg: DaemonConfig
  /** The disk itself, for what only the adapter knows: whether this platform can watch. */
  disk: NodeFileSystem
  /** The disk as the engine sees it: a file still being written is left for the next round. */
  fs: SettlingFileSystem
  state: SqliteStateStore
  client: VaultClient
  /** Hidden paths, the ignore file and the files still being written, as one. */
  ignore: PathMatcher
  /** `.abele-sync-ignore` as it reads, or null when the vault has none: part of the scope key. */
  ignoreText: string | null
  /** What this device syncs at all, as `scan` asks it. */
  filter: ScanFilter
  recovery?: RecoveryBarrier
  fence?: EffectFence
  close(): void
}

/** Every dot-segment path but `.obsidian/`, as the plugin ignores them (see `isHidden`). */
const HIDDEN: PathMatcher = { ignores: isHidden }

/** The vault's config, or a usage error naming what has to happen first. */
export function requireConfig(dir: string): DaemonConfig {
  const cfg = readConfig(dir)
  if (cfg === null) {
    assertLocalSafety(dir)
    throw new UsageError(`${dir} is not set up: run \`abele-sync init --dir ${dir} …\` first`)
  }
  return cfg
}

/** Opens everything a command works through. The caller closes it, failure or not. */
const publicationRecovery = new WeakMap<OpenVault, (disk: FileSystem) => Promise<void>>()

export function openVault(dir: string, ctx: CommandContext, held?: () => boolean): OpenVault {
  if (held && !held()) throw new EngineError('lost', 'vault lock lost before recovery inspection')
  assertLocalSafety(dir, false, true, held !== undefined)
  const cfg = requireConfig(dir)
  const fence = held ? new EffectFence(dir, held, () => personalStamp(dir)) : undefined
  // Hidden folders are not walked or watched: the filter below would pass over all of it.
  const disk = new NodeFileSystem(dir, {
    skipHidden: true,
    effectGuard: fence?.assertReady,
    effectTracker: fence?.track,
  })
  const fs = new SettlingFileSystem(disk)
  const ignoreText = readIgnoreText(dir)
  const rules = ignoreText === null ? null : IgnoreRules.parse(ignoreText)
  // Hidden paths first: no ignore file can bring a `.git` or a `.DS_Store` into the vault.
  const ignore = anyOf([HIDDEN, ...(rules === null ? [] : [rules]), fs])
  let state: SqliteStateStore
  try {
    state = SqliteStateStore.open(stateDbFile(dir), { effectGuard: fence?.assertOwner })
  } catch (error) {
    fence?.close()
    throw error
  }
  try {
    fence?.attach(state, stateDbFile(dir))
    const owner = statedVault(state)
    if (owner !== null && owner !== cfg.vaultId) {
      throw new UsageError(
        'state.db describes another vault; run init --force to reconcile the configuration before syncing'
      )
    }
    const vault: OpenVault = {
      dir,
      cfg,
      disk,
      fs,
      state,
      client: vaultClient(cfg, fence ? { ...ctx, fetch: fence.fetch(ctx.fetch) } : ctx),
      ignore,
      ignoreText,
      filter: {
        excluded: (path, size) =>
          isExcluded(path, size, cfg.selective, SCRIPTS_FOLDER) || ignore.ignores(path),
      },
      ...(fence ? { fence, recovery: fence.recovery } : {}),
      close: () => {
        fence?.close()
        state.close()
      },
    }
    const replay = vaultClient(cfg, {
      ...ctx,
      fetch: (input, init) => {
        fence?.assertOwner()
        return fence ? fence.track(() => ctx.fetch(input, init)) : ctx.fetch(input, init)
      },
    })
    publicationRecovery.set(vault, async (disk) => {
      if (await state.getJournal())
        await resumeJournal(replay, disk, state, {
          expected: new ExpectedWrites(),
          filter: vault.filter,
          defer: (path) => codePluginId(path) !== null,
          onDefer: (items) => new StagedChanges(state).stage(items),
        })
    })
    return vault
  } catch (error) {
    // Nothing may be left holding the database when the caller never got a handle to close.
    fence?.close()
    state.close()
    throw error
  }
}

/** Owned installation recovery and predecessor settlement precede ordinary engine effects. */
export async function recoverVault(vault: OpenVault, held: () => boolean): Promise<void> {
  if (!held()) throw new EngineError('lost', 'vault lock lost before recovery')
  await vault.fence?.settlePredecessors()
  assertLocalSafety(vault.dir, false, true, true)
  const recoveryDisk = new NodeFileSystem(vault.dir, {
    skipHidden: true,
    effectGuard:
      vault.fence?.assertOwner ??
      (() => {
        if (!held()) throw new EngineError('lost', 'recovery ownership lost')
      }),
    effectTracker: vault.fence?.track,
  })
  await CodeGroupDisk.recover({ ...vault, disk: recoveryDisk }, held)
  const pullIds = vault.state
    .metadataKeys('pull-write:')
    .map((key) => key.slice('pull-write:'.length))
  await recoverPendingPullWrites(recoveryDisk, vault.state, pullIds)
  await publicationRecovery.get(vault)?.(recoveryDisk)
  publicationRecovery.delete(vault)
  assertLocalSafety(vault.dir)
  vault.recovery?.activate()
}

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

/** A client on this device's token, for what it asks about itself. Nothing here ever prints it. */
export function deviceClient(cfg: DaemonConfig, ctx: CommandContext): SyncClient {
  return new SyncClient({
    baseUrl: requireServerUrl(cfg.serverUrl),
    fetch: ctx.fetch,
    WebSocket: ctx.WebSocket,
    token: cfg.deviceToken,
    userAgent: 'abele-sync-daemon',
  })
}

/**
 * A client for telling the server this device is leaving, which gives up after
 * `ctx.revokeTimeoutMs`. A give-up is a fetch that rejects, so it reads as `offline`.
 */
export function leavingClient(cfg: DaemonConfig, ctx: CommandContext): SyncClient {
  return deviceClient(cfg, { ...ctx, fetch: withTimeout(ctx.fetch, ctx.revokeTimeoutMs) })
}

function withTimeout(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return fetchImpl(input, { ...init, signal })
  }
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
export function vaultClient(cfg: DaemonConfig, ctx: CommandContext): VaultClient {
  return deviceClient(cfg, ctx).forVault(cfg.vaultId)
}

/** What a command hands the engine besides the vault: its clock, its log, and its hooks. */
export interface EngineHooks {
  fallbackMs: number
  log: (line: string) => void
  onSync?: (report: SyncReport) => void
  onFail?: (error: unknown, kind: SyncFailure) => void
  /** Whether the daemon still holds the vault's lock; asked before every commit and write. */
  stillHeld?: () => boolean
}

/** The engine, on an opened vault. `log` takes the engine's own lines as well as ours. */
export function buildEngine(
  vault: Omit<OpenVault, 'fs'> & { fs: FileSystem },
  opts: EngineHooks
): SyncEngine {
  return new SyncEngine({
    client: vault.client,
    fs: vault.fs,
    state: vault.state,
    selective: vault.cfg.selective,
    // No daemon entry point may install another plugin's code without the code command.
    defer: (path) => codePluginId(path) !== null,
    ignore: vault.ignore,
    ignoreText: vault.ignoreText,
    fallbackMs: opts.fallbackMs,
    ...(vault.cfg.joinPrefer === undefined ? {} : { joinPrefer: vault.cfg.joinPrefer }),
    ...(opts.onSync === undefined ? {} : { onSync: opts.onSync }),
    ...(opts.onFail === undefined ? {} : { onFail: opts.onFail }),
    ...(opts.stillHeld === undefined ? {} : { stillHeld: opts.stillHeld }),
    ...(vault.recovery ? { recovery: vault.recovery } : {}),
    log: opts.log,
  })
}

/** What to do about a token the server no longer takes, in the words every command uses. */
export const REVOKED_HINT =
  'the device was revoked or the token is invalid; remove `.abele-sync/config.json` ' +
  '(or run `abele-sync init --force`) and enrol again'

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
  client: VaultClient,
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
    `sync: done (pulled ${pulled}, pushed ${report.push.applied}, ` +
    `merged ${report.push.merged}, conflicts ${report.push.conflicts}, ` +
    `rejected ${report.push.rejected.length}, pulls waiting ${waiting})`
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
