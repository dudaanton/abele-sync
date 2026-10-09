import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  ConnectionBindingSchema,
  EngineError,
  ExternalStateError,
  sameConnection,
  selectiveDefaults,
  type ConnectionBinding,
  type SelectiveSettings,
} from '@abele/sync-core'
import type { JoinPrefer } from '@abele/sync-protocol'
import { STATE_DIR } from './nodeFs.js'

/** Everything the daemon needs to reach a vault, including the secret it signs in with. */
export interface DaemonConfig {
  serverUrl: string
  vaultId: string
  deviceId: string
  deviceToken: string
  deviceName: string
  selective: SelectiveSettings
  /**
   * The side that wins, while this folder joins its vault, where both hold a file: `mine` or
   * `theirs` (`init --prefer local|server`). Absent is "merge both". `run` removes it once a
   * sync has finished the join.
   */
  joinPrefer?: JoinPrefer
}

const CONFIG_FILE = 'config.json'
/** The folder holds a token, so nobody else on the machine gets to look. */
const FOLDER_MODE = 0o700
const FILE_MODE = 0o600

/** `<dir>/.abele-sync`, where everything the daemon owns lives. */
export const stateFolder = (dir: string): string => join(dir, STATE_DIR)

/** The state folder, created at `0700` if it is not there yet. */
export function ensureStateFolder(dir: string): string {
  const folder = stateFolder(dir)
  try {
    // mkdir's mode is masked by the umask and says nothing about a folder that already exists,
    // so the mode is set again either way.
    mkdirSync(folder, { recursive: true, mode: FOLDER_MODE })
    chmodSync(folder, FOLDER_MODE)
  } catch (cause) {
    throw new EngineError('io', `cannot create ${folder}`, cause)
  }
  return folder
}

/**
 * The vault's config, or `null` when this vault was never set up.
 *
 * A file that is there but unreadable, unparseable or missing a field is an error rather than a
 * `null`: a daemon that treated a damaged config as "not set up" would ask for a fresh login and
 * write over the token that is still in the file.
 */
export function assertNoAgentConnection(dir: string): void {
  if (
    ['agent.json', 'agent.sqlite', 'agent.sqlite-wal', 'agent.sqlite-shm'].some((name) =>
      existsSync(join(stateFolder(dir), name))
    )
  )
    throw new EngineError(
      'conflict',
      'this vault has an agent connection; use the agent commands, never personal fallback'
    )
}
export function readConfig(dir: string): DaemonConfig | null {
  assertNoAgentConnection(dir)
  const file = join(stateFolder(dir), CONFIG_FILE)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    if (isMissing(cause)) return null
    throw new EngineError('io', `cannot read ${file}`, cause)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new EngineError('io', `${file} is not valid JSON`, cause)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new EngineError('io', `${file} is not a config object`)
  }
  let raw = parsed as Record<string, unknown>
  let descriptor: LocalDescriptor | null = null
  if (raw.schema !== undefined || raw.format !== undefined) {
    if (
      raw.format !== 'abele.cli' ||
      raw.schema !== 2 ||
      typeof raw.connection !== 'object' ||
      raw.connection === null
    )
      throw new ExternalStateError('recovery-required')
    descriptor = parseLocalDescriptor(raw.descriptor)
    raw = raw.connection as Record<string, unknown>
  }
  const config: DaemonConfig = {
    serverUrl: required(raw, 'serverUrl', file),
    vaultId: required(raw, 'vaultId', file),
    deviceId: required(raw, 'deviceId', file),
    deviceToken: required(raw, 'deviceToken', file),
    deviceName: required(raw, 'deviceName', file),
    selective: readSelective(raw.selective),
    ...readJoinPrefer(raw.joinPrefer, file),
  }
  if (
    descriptor &&
    !sameConnection(descriptor.binding, personalBinding(config, descriptor.binding.generation))
  )
    throw new ExternalStateError('binding-mismatch')
  return config
}

/**
 * The join preference, if the config has one. A value that is neither is refused rather than
 * read as "merge": it is somebody's edit, and which side wins is not a thing to guess.
 */
function readJoinPrefer(value: unknown, file: string): { joinPrefer?: JoinPrefer } {
  if (value === undefined) return {}
  if (value === 'mine' || value === 'theirs') return { joinPrefer: value }
  throw new EngineError('io', `${file} has a joinPrefer that is neither mine nor theirs`)
}

/** Writes the config through a temp file, so a crash never leaves half a token behind. */
export function writeConfig(dir: string, cfg: DaemonConfig): void {
  const descriptor = readConfigDescriptor(dir)
  if (descriptor) {
    writeVersionedConfig(dir, cfg, descriptor)
    return
  }
  writeOwnedJson(dir, CONFIG_FILE, cfg)
}

export function writeOwnedJson(
  dir: string,
  name: string,
  value: unknown,
  guard: () => void = () => {}
): void {
  guard()
  if (!/^[a-z0-9.-]+$/.test(name) || name.includes('..'))
    throw new EngineError('io', 'invalid local descriptor name')
  const folder = ensureStateFolder(dir)
  const temp = join(folder, `${name}.${randomBytes(6).toString('hex')}`)
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE })
    chmodSync(temp, FILE_MODE)
    guard()
    renameSync(temp, join(folder, name))
  } catch (cause) {
    remove(temp)
    if (cause instanceof EngineError || cause instanceof ExternalStateError) throw cause
    throw new EngineError('io', `cannot write ${join(folder, name)}`, cause)
  }
}

export interface LocalDescriptor {
  ledgerId: string
  instanceId: string
  binding: ConnectionBinding
}
export function parseLocalDescriptor(input: unknown): LocalDescriptor {
  if (!input || typeof input !== 'object') throw new ExternalStateError('recovery-required')
  const raw = input as Record<string, unknown>
  if (
    typeof raw.ledgerId !== 'string' ||
    !raw.ledgerId ||
    typeof raw.instanceId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(raw.instanceId)
  )
    throw new ExternalStateError('recovery-required')
  try {
    return {
      ledgerId: raw.ledgerId,
      instanceId: raw.instanceId,
      binding: ConnectionBindingSchema.parse(raw.binding),
    }
  } catch (cause) {
    throw new ExternalStateError('recovery-required', { cause })
  }
}
export function personalBinding(cfg: DaemonConfig, generation = 1): ConnectionBinding {
  return ConnectionBindingSchema.parse({
    endpoint: cfg.serverUrl,
    vaultId: cfg.vaultId,
    mode: 'personal',
    principalId: cfg.deviceId,
    principalType: 'device',
    grantId: null,
    generation,
    credentialAssociation: createHash('sha256').update(cfg.deviceToken).digest('hex'),
  })
}
export function readConfigDescriptor(dir: string): LocalDescriptor | null {
  const file = join(stateFolder(dir), CONFIG_FILE)
  if (!existsSync(file)) return null
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  } // Legacy force recovery remains available before activation.
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.schema === undefined && raw.format === undefined) return null
  if (raw.schema !== 2 || raw.format !== 'abele.cli')
    throw new ExternalStateError('recovery-required')
  return parseLocalDescriptor(raw.descriptor)
}
export function writeVersionedConfig(
  dir: string,
  cfg: DaemonConfig,
  descriptor: LocalDescriptor,
  guard?: () => void
): void {
  const checked = parseLocalDescriptor(descriptor)
  if (!sameConnection(checked.binding, personalBinding(cfg, checked.binding.generation)))
    throw new ExternalStateError('binding-mismatch')
  writeOwnedJson(
    dir,
    CONFIG_FILE,
    { format: 'abele.cli', schema: 2, connection: cfg, descriptor: checked },
    guard
  )
}

function required(raw: Record<string, unknown>, key: keyof DaemonConfig, file: string): string {
  const value = raw[key]
  if (typeof value !== 'string' || value === '') {
    throw new EngineError('io', `${file} has no ${key}`)
  }
  return value
}

/**
 * Selective settings over the defaults, field by field: a config written by an older build is
 * missing whatever was added since, and the daemon syncs those categories rather than refusing
 * to start.
 */
function readSelective(value: unknown): SelectiveSettings {
  const defaults = selectiveDefaults()
  if (typeof value !== 'object' || value === null) return defaults
  const raw = value as Record<string, unknown>
  const settings = typeof raw.settings === 'object' && raw.settings !== null ? raw.settings : {}
  const flags = settings as Record<string, unknown>
  return {
    images: bool(raw.images, defaults.images),
    audio: bool(raw.audio, defaults.audio),
    video: bool(raw.video, defaults.video),
    pdf: bool(raw.pdf, defaults.pdf),
    other: bool(raw.other, defaults.other),
    excludedFolders: Array.isArray(raw.excludedFolders)
      ? raw.excludedFolders.filter((f): f is string => typeof f === 'string')
      : defaults.excludedFolders,
    maxFileBytes: typeof raw.maxFileBytes === 'number' ? raw.maxFileBytes : defaults.maxFileBytes,
    settings: {
      main: bool(flags.main, defaults.settings.main),
      appearance: bool(flags.appearance, defaults.settings.appearance),
      hotkeys: bool(flags.hotkeys, defaults.settings.hotkeys),
      corePlugins: bool(flags.corePlugins, defaults.settings.corePlugins),
      communityPlugins: bool(flags.communityPlugins, defaults.settings.communityPlugins),
      pluginSettings: bool(flags.pluginSettings, defaults.settings.pluginSettings),
    },
  }
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

function remove(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    /* already gone */
  }
}

const isCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === code

const isMissing = (cause: unknown): boolean => isCode(cause, 'ENOENT') || isCode(cause, 'ENOTDIR')
