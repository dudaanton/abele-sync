import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path'
import {
  selectiveDefaults,
  EngineError,
  DeleteHolds,
  DEFAULT_DELETE_WINDOW_MS,
  ExpectedWrites,
  resumeJournal,
  fenceRestoredJournal,
  recoverPendingPullWrites,
  StagedChanges,
  IgnoreRules,
  isExcluded,
  isHidden,
  V2EngineClient,
  SyncEngine,
  type FileSystem,
  type PathMatcher,
  type ScanFilter,
  type SelectiveSettings,
  type SyncFailure,
  type SyncReport,
  type RecoveryBarrier,
  type AppliedChange,
} from '@abele/sync-core'
import { normalizeServerUrl, serverUrlProblem, decodeAccessToken } from '@abele/sync-protocol'
import { readConfig, writeConfig, stateFolder, type DaemonConfig } from './config.js'
import { acquireLock } from './lock.js'
import {
  assertLocalSafety,
  assertClaim,
  EffectFence,
  inspectProjectionInventory,
  personalStamp,
} from './externalSafety.js'
import { CodeGroupDisk } from './codeGroupDisk.js'
import { anyOf, SettlingFileSystem } from './growing.js'
import { NodeFileSystem } from './nodeFs.js'
import { SqliteStateStore } from './sqliteState.js'
import { NodeReplicaConfigError as UsageError } from './replicaError.js'

/** Where the daemon keeps what it has synced. */
export const stateDbFile = (dir: string, stateDir?: string): string =>
  join(stateFolder(dir, stateDir), 'state.db')

/** The vault's ignore file, beside the state folder rather than inside it. */
export const ignoreFile = (dir: string): string => join(dir, '.abele-sync-ignore')

/** The folder whose files count as scripts, matching the engine's own default. */
export const SCRIPTS_FOLDER = 'Scripts'

/** How often a daemon syncs with nothing prompting it. */
export const DEFAULT_INTERVAL_SECONDS = 300
/** The shortest interval worth asking for: below this a vault is rescanned faster than it settles. */
export const MIN_INTERVAL_SECONDS = 5

export interface NodeReplica {
  stateDir?: string
  dir: string
  cfg: DaemonConfig
  /** The disk itself, for what only the adapter knows: whether this platform can watch. */
  disk: NodeFileSystem
  /** The disk as the engine sees it: a file still being written is left for the next round. */
  fs: SettlingFileSystem
  state: SqliteStateStore
  client: V2EngineClient
  /** Hidden paths, the ignore file and the files still being written, as one. */
  ignore: PathMatcher
  /** `.abele-sync-ignore` as it reads, or null when the vault has none: part of the scope key. */
  ignoreText: string | null
  /** What this device syncs at all, as `scan` asks it. */
  filter: ScanFilter
  recovery?: RecoveryBarrier
  fence?: EffectFence
  /** Optional host policy for staging remote changes. */
  readonly defer?: (path: string) => boolean
  buildEngine(opts: EngineHooks): SyncEngine
  recover(held?: () => boolean): Promise<void>
  close(): void
}

/** Every dot-segment path but `.obsidian/`, as the plugin ignores them (see `isHidden`). */
const HIDDEN: PathMatcher = { ignores: isHidden }

/** The vault's config, or a usage error naming what has to happen first. */
function requireConfig(dir: string): DaemonConfig {
  const cfg = readConfig(dir)
  if (cfg === null) {
    assertLocalSafety(dir)
    throw new UsageError(`${dir} has no connection configuration`)
  }
  return cfg
}

/** Opens everything a command works through. The caller closes it, failure or not. */
const publicationRecovery = new WeakMap<NodeReplica, (disk: FileSystem) => Promise<void>>()
const pullRecoveryClients = new WeakMap<NodeReplica, ReturnType<typeof nodeReplicaClient>>()
const inspectedVaults = new WeakSet<NodeReplica>()

/** Async command composition: one bounded discovery pass before any ledger bootstrap. */
export async function prepareNodeReplica(
  dir: string,
  ctx: NodeTransport,
  held?: () => boolean,
  defer?: (path: string) => boolean
): Promise<NodeReplica> {
  requireServerUrl(requireConfig(dir).serverUrl)
  const stamp = personalStamp(dir)
  const guard = () => {
    if (held) assertClaim(held)
    if (personalStamp(dir) !== stamp)
      throw new EngineError('lost', 'connection changed during recovery inspection')
  }
  guard()
  assertLocalSafety(dir, false, true, held !== undefined, held === undefined)
  await inspectProjectionInventory(dir, { guard, selective: requireConfig(dir).selective })
  guard()
  const vault = openNodeReplica({
    dir,
    config: requireConfig(dir),
    fetch: ctx.fetch,
    ...(ctx.WebSocket ? { WebSocket: ctx.WebSocket } : {}),
    ...(held ? { held } : {}),
    ...(defer ? { defer } : {}),
  })
  inspectedVaults.add(vault)
  if (!held) vault.recovery?.activate()
  return vault
}

function openConfiguredReplica(
  dir: string,
  ctx: NodeTransport,
  held?: () => boolean,
  config?: DaemonConfig,
  defer?: (path: string) => boolean,
  stateDir?: string
): NodeReplica {
  if (held && !held()) throw new EngineError('lost', 'vault lock lost before recovery inspection')
  assertLocalSafety(
    dir,
    false,
    true,
    held !== undefined,
    held === undefined,
    false,
    undefined,
    stateDir
  )
  const cfg = config ?? requireConfig(dir)
  const fence = new EffectFence(dir, held, () => personalStamp(dir, stateDir), stateDir)
  let attached = false
  // Hidden folders are not walked or watched: the filter below would pass over all of it.
  const disk = new NodeFileSystem(dir, {
    skipHidden: true,
    preserveEmptyDirectories: true,
    effectGuard: () => {
      if (!held) throw new EngineError('lost', 'filesystem mutation requires an owned vault lock')
      fence.assertReady()
    },
    effectTracker: fence.track,
  })
  const fs = new SettlingFileSystem(disk)
  const ignoreText = readIgnoreText(dir)
  const rules = ignoreText === null ? null : IgnoreRules.parse(ignoreText)
  // Hidden paths first: no ignore file can bring a `.git` or a `.DS_Store` into the vault.
  const ignore = anyOf([HIDDEN, ...(rules === null ? [] : [rules]), fs])
  let state: SqliteStateStore
  try {
    state = SqliteStateStore.open(stateDbFile(dir, stateDir), {
      effectGuard: () => {
        if (!held && attached) fence.assertReady()
        else fence.assertOwner()
      },
      effectOwner: fence.effectOwner,
    })
  } catch (error) {
    fence?.close()
    throw error
  }
  try {
    fence.attach(state, stateDbFile(dir, stateDir))
    attached = true
    if (stateDir) {
      const boundDir = state.getMeta('node:bound-dir')
      if (boundDir !== null && boundDir !== realpathSync(dir))
        throw new UsageError('stateDir belongs to another directory')
      if (boundDir === null) {
        if (!held?.()) throw new UsageError('binding stateDir requires an owned vault lock')
        state.setMeta('node:bound-dir', realpathSync(dir))
      }
    }
    const bound = state.getMeta('token-connection')
    if (bound !== null && bound !== createHash('sha256').update(cfg.deviceToken).digest('hex'))
      throw new UsageError('connection ledger binding mismatch')
    const owner = statedVault(state)
    if (owner !== null && owner !== cfg.vaultId) {
      throw new UsageError(
        'state.db describes another space; preserve this ledger and connect in a fresh directory'
      )
    }
    const vault: NodeReplica = {
      ...(stateDir ? { stateDir } : {}),
      dir,
      cfg,
      ...(defer ? { defer } : {}),
      disk,
      fs,
      state,
      client: nodeReplicaClient(cfg, { ...ctx, fetch: fence.fetch(ctx.fetch) }),
      ignore,
      ignoreText,
      filter: {
        excluded: (path, size) =>
          isExcluded(path, size, cfg.selective, SCRIPTS_FOLDER) || ignore.ignores(path),
      },
      fence,
      recovery: fence.recovery,
      buildEngine: (opts) => buildNodeEngine(vault, opts),
      recover: (claim = held) => {
        if (!claim) throw new EngineError('lost', 'recovery requires an owned vault lock')
        return recoverNodeReplica(vault, claim)
      },
      close: () => {
        fence?.close()
        state.close()
      },
    }
    const replay = nodeReplicaClient(cfg, {
      ...ctx,
      fetch: (input, init) => {
        fence.assertOwner()
        return fence.track(() => ctx.fetch(input, init))
      },
    })
    pullRecoveryClients.set(vault, replay)
    publicationRecovery.set(vault, async (disk) => {
      if (await state.getJournal()) {
        await fenceRestoredJournal(state, (await replay.state()).head_seq, disk, undefined, replay)
        const holds = new DeleteHolds(state),
          filed = await holds.decision()
        if (filed !== null) await holds.resetTally()
        const confirmed = new Set(filed?.decision.kind === 'confirm' ? filed.decision.fileIds : [])
        await resumeJournal(replay, disk, state, {
          expected: new ExpectedWrites(),
          filter: vault.filter,
          ...(defer ? { defer } : {}),
          onDefer: (items) => new StagedChanges(state, disk).stage(items),
          onCommitted: (ops, tx) =>
            holds.tally(
              Date.now(),
              ops.filter((op) => op.op === 'delete' && !confirmed.has(op.file_id)).length,
              DEFAULT_DELETE_WINDOW_MS,
              tx
            ),
        })
      }
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
export async function recoverNodeReplica(vault: NodeReplica, held: () => boolean): Promise<void> {
  if (!held()) throw new EngineError('lost', 'vault lock lost before recovery')
  await vault.fence?.settlePredecessors()
  assertLocalSafety(vault.dir, false, true, true, false, false, undefined, vault.stateDir)
  if (!inspectedVaults.has(vault)) {
    await inspectProjectionInventory(vault.dir, {
      guard: vault.fence?.assertOwner ?? (() => assertClaim(held)),
      selective: vault.cfg.selective,
      stateDir: vault.stateDir,
    })
    inspectedVaults.add(vault)
  }
  const recoveryDisk = new NodeFileSystem(vault.dir, {
    skipHidden: true,
    effectGuard:
      vault.fence?.assertOwner ??
      (() => {
        if (!held()) throw new EngineError('lost', 'recovery ownership lost')
      }),
    effectTracker: vault.fence?.track,
  })
  // Rollback compares public before/after images. Finish any interrupted file
  // capture/publication first so its victim cannot look like an unrelated deletion.
  await recoveryDisk.recoverConditionalFiles()
  await CodeGroupDisk.recover({ ...vault, disk: recoveryDisk }, held)
  // Local installation evidence must be checked without HTTP first. Only retained remote
  // effects require a generation handshake here; ordinary sync prepares its client itself.
  if ((await vault.state.getJournal()) || vault.state.metadataKeys('pull-write:').length > 0)
    await pullRecoveryClients.get(vault)?.prepare?.(recoveryDisk, vault.state)
  const pullIds = vault.state
    .metadataKeys('pull-write:')
    .map((key) => key.slice('pull-write:'.length))
  await recoverPendingPullWrites(recoveryDisk, vault.state, pullIds, pullRecoveryClients.get(vault))
  pullRecoveryClients.delete(vault)
  await publicationRecovery.get(vault)?.(recoveryDisk)
  publicationRecovery.delete(vault)
  assertLocalSafety(vault.dir, false, true, false, false, false, undefined, vault.stateDir)
  vault.recovery?.activate()
}

function requireServerUrl(url: string): string {
  const problem = serverUrlProblem(url)
  if (problem !== null) throw new UsageError(`${url}: ${problem}`)
  const normal = normalizeServerUrl(url)
  if (normal === null) throw new UsageError(`${url}: the address cannot be read`)
  return normal
}

/** A client on this vault's device token. */
export function nodeReplicaClient(cfg: DaemonConfig, ctx: NodeTransport): V2EngineClient {
  validateConfig(cfg)
  return new V2EngineClient(cfg.deviceToken, {
    fetch: ctx.fetch,
    WebSocket: ctx.WebSocket,
    userAgent: 'abele-sync-daemon',
  })
}

function validateConfig(cfg: DaemonConfig): void {
  requireServerUrl(cfg.serverUrl)
  const encoded = decodeAccessToken(cfg.deviceToken)
  if (encoded.address !== cfg.serverUrl) throw new UsageError('stored token address mismatch')
}

/** What a command hands the engine besides the vault: its clock, its log, and its hooks. */
export interface EngineHooks {
  fallbackMs: number
  log: (line: string) => void
  onSync?: (report: SyncReport) => void
  onFail?: (error: unknown, kind: SyncFailure) => void
  /** Called after an applied change, with the core engine's path and origin context. */
  onApplied?: (change: AppliedChange) => void | Promise<void>
  /** Whether the daemon still holds the vault's lock; asked before every commit and write. */
  stillHeld?: () => boolean
}

/** The engine, on an opened vault. `log` takes the engine's own lines as well as ours. */
export function buildNodeEngine(
  vault: Omit<NodeReplica, 'fs' | 'state'> & {
    fs: FileSystem
    state: import('@abele/sync-core').StateStore
  },
  opts: EngineHooks
): SyncEngine {
  return new SyncEngine({
    client: vault.client,
    fs: vault.fs,
    state: vault.state,
    selective: vault.cfg.selective,
    ...(vault.defer ? { defer: vault.defer } : {}),
    ignore: vault.ignore,
    ignoreText: vault.ignoreText,
    fallbackMs: opts.fallbackMs,
    ...(vault.cfg.joinPrefer === undefined ? {} : { joinPrefer: vault.cfg.joinPrefer }),
    ...(opts.onSync === undefined ? {} : { onSync: opts.onSync }),
    ...(opts.onFail === undefined ? {} : { onFail: opts.onFail }),
    ...(opts.onApplied === undefined ? {} : { onApplied: opts.onApplied }),
    ...(opts.stillHeld === undefined ? {} : { stillHeld: opts.stillHeld }),
    ...(vault.recovery ? { recovery: vault.recovery } : {}),
    log: opts.log,
  })
}

export type NodeReplicaConfig = DaemonConfig

export interface NodeTransport {
  fetch: typeof globalThis.fetch
  WebSocket?: typeof globalThis.WebSocket
}
export interface NodeReplicaOptions {
  /** Durable ledger and credentials. Atomic installation temps remain inside dir. */
  stateDir?: string
  dir: string
  config: DaemonConfig
  fetch?: typeof globalThis.fetch
  WebSocket?: typeof globalThis.WebSocket
  /** An externally owned lock. Without it the replica is an observer and cannot sync. */
  held?: () => boolean
  defer?: (path: string) => boolean
}
export interface NodeKeyOptions extends Omit<NodeReplicaOptions, 'config' | 'held'> {
  key: string
  selective?: SelectiveSettings
  lockTiming?: { heartbeatMs: number; watchMs: number }
}
/** Config opens synchronously under the caller claim; key opens own and release a lock. */
export function openNodeReplica(options: NodeReplicaOptions): NodeReplica
export function openNodeReplica(options: NodeKeyOptions): Promise<NodeReplica>
export function openNodeReplica(
  options: NodeReplicaOptions | NodeKeyOptions
): NodeReplica | Promise<NodeReplica> {
  if ('key' in options) return openKeyReplica(options)
  const stateDir = resolveStateDir(options.dir, options.stateDir)
  const transport: NodeTransport = {
    fetch: options.fetch ?? globalThis.fetch,
    ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
  }
  validateConfig(options.config)
  assertDirectoryBinding(options.dir, stateDir)
  const stored = readConfig(options.dir, stateDir)
  if (!stored) {
    if (!options.held?.())
      throw new UsageError('initializing a replica requires an owned vault lock')
    assertLocalSafety(options.dir, false, true, false, false, false, undefined, stateDir)
    assertLedgerBinding(options.dir, options.config.deviceToken, stateDir)
    writeConfig(options.dir, options.config, stateDir)
  } else if (!isDeepStrictEqual(stored, options.config)) {
    throw new UsageError('connection configuration mismatch')
  }
  return openConfiguredReplica(
    options.dir,
    transport,
    options.held,
    options.config,
    options.defer,
    stateDir
  )
}
async function openKeyReplica(options: NodeKeyOptions): Promise<NodeReplica> {
  const stateDir = resolveStateDir(options.dir, options.stateDir)
  const decoded = decodeAccessToken(options.key)
  requireServerUrl(decoded.address)
  mkdirSync(options.dir, { recursive: true })
  const lock = await acquireLock(options.dir, options.lockTiming)
  let replica: NodeReplica | undefined
  let stateLock: Awaited<ReturnType<typeof acquireLock>> | undefined
  try {
    // The transient directory claim is shared with CLI/default opens. The second
    // claim protects external state even when another directory tries to use it.
    if (stateDir) stateLock = await acquireLock(options.dir, { ...options.lockTiming, stateDir })
    assertDirectoryBinding(options.dir, stateDir)
    assertLocalSafety(options.dir, false, true, true, false, false, undefined, stateDir)
    let config = readConfig(options.dir, stateDir)
    if (config && config.deviceToken !== options.key)
      throw new UsageError('connection configuration mismatch')
    if (!config) {
      const transport: NodeTransport = {
        fetch: options.fetch ?? globalThis.fetch,
        ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
      }
      const info = await new V2EngineClient(options.key, transport).connection()
      assertClaim(lock.held)
      assertLocalSafety(options.dir, false, true, false, false, false, undefined, stateDir)
      assertLedgerBinding(options.dir, options.key, stateDir)
      config = {
        serverUrl: decoded.address,
        deviceToken: options.key,
        vaultId: info.space_id,
        deviceId: info.token_id,
        deviceName: 'token connection',
        selective: options.selective ?? selectiveDefaults(),
      }
    }
    const { key: _key, ...configured } = options
    replica = openNodeReplica({
      ...configured,
      config,
      held: () => lock.held() && (stateLock?.held() ?? true),
    })
    await replica.recover()
    const close = replica.close
    let closed = false
    replica.close = () => {
      if (closed) return
      closed = true
      try {
        close()
      } finally {
        stateLock?.()
        lock()
      }
    }
    return replica
  } catch (error) {
    replica?.close()
    stateLock?.()
    lock()
    throw error
  }
}
const statedVault = (state: SqliteStateStore): string | null => state.getMeta('vault')
export function readIgnoreText(dir: string): string | null {
  try {
    return readFileSync(ignoreFile(dir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertLedgerBinding(dir: string, key: string, stateDir?: string): void {
  if (!existsSync(stateDbFile(dir, stateDir))) return
  const state = SqliteStateStore.openReadOnlySnapshot(stateDbFile(dir, stateDir))
  try {
    if (state.getMeta('token-connection') !== createHash('sha256').update(key).digest('hex'))
      throw new UsageError(
        'this directory retains another connection ledger; use a fresh directory'
      )
  } finally {
    state.close()
  }
}

// Resolve existing ancestors too, so symlink aliases cannot hide a nested stateDir.
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return realpathSync(absolute)
  return join(canonicalPath(dirname(absolute)), basename(absolute))
}
function resolveStateDir(dir: string, requested?: string): string | undefined {
  if (requested === undefined) return undefined
  const root = canonicalPath(dir),
    folder = canonicalPath(requested)
  if (folder === canonicalPath(stateFolder(dir))) return undefined
  const child = relative(root, folder)
  if (!child || (!child.startsWith('..' + '/') && child !== '..' && !isAbsolute(child)))
    throw new UsageError('stateDir must not be inside the synced directory')
  // Installation temp/stage/code-group files deliberately keep using dir/.abele-sync:
  // rename into the synced tree must stay on the same filesystem to be atomic.
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  return folder
}

function assertDirectoryBinding(dir: string, stateDir?: string): void {
  if (!stateDir || !existsSync(stateDbFile(dir, stateDir))) return
  const snapshot = SqliteStateStore.openReadOnlySnapshot(stateDbFile(dir, stateDir))
  try {
    const bound = snapshot.getMeta('node:bound-dir')
    if (bound === null)
      throw new UsageError('stateDir has an unbound ledger; use a fresh state directory')
    if (bound !== null && bound !== realpathSync(dir))
      throw new UsageError('stateDir belongs to another directory')
  } finally {
    snapshot.close()
  }
}
