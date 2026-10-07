import { registeredConfigurationDirectories } from './scoped/folderSecurity.js'

/** Server configuration, read once from the process environment. */
export interface Config {
  databaseUrl: string
  blobDir: string
  /** 32 bytes, decoded from the 64 hex characters of ABELE_MASTER_KEY. */
  masterKey: Buffer
  tokenPepper: string
  publicUrl: string
  port: number
  host: string
  /**
   * Whether `X-Forwarded-For` is believed: never, always, or only from the
   * listed proxies (IPs and CIDRs). Behind Caddy every request arrives from one
   * address, and the login rate limit would be one budget for everybody.
   */
  trustProxy: boolean | string[]
  maxFileBytes: number
  simpleUploadBytes: number
  partBytes: number
  accountTokenTtlMs: number
  idempotencyTtlMs: number
  retentionIntervalMs: number
  wsHelloTimeoutMs: number
  /** Explicit all-or-nothing activation of scoped sync, management and publication. */
  scopedSharing: boolean
  /** Trusted registered configuration roots; cannot be overridden by a scoped request. */
  configurationDirectories?: readonly string[]
}

const MB = 1024 * 1024
const HOUR_MS = 60 * 60 * 1000

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const masterKeyHex = env.ABELE_MASTER_KEY
  if (!masterKeyHex) throw new Error('ABELE_MASTER_KEY is required')
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex))
    throw new Error('ABELE_MASTER_KEY must be 64 hex characters')

  const tokenPepper = env.ABELE_TOKEN_PEPPER
  if (!tokenPepper) throw new Error('ABELE_TOKEN_PEPPER is required')

  return {
    databaseUrl: env.ABELE_DATABASE_URL ?? 'sqlite://data/abele.db',
    blobDir: env.ABELE_BLOB_DIR ?? 'data/blobs',
    masterKey: Buffer.from(masterKeyHex, 'hex'),
    tokenPepper,
    publicUrl: env.ABELE_PUBLIC_URL ?? 'http://localhost:8787',
    port: portFromEnv(env.ABELE_PORT, 8787, 'ABELE_PORT'),
    host: env.ABELE_HOST ?? '0.0.0.0',
    trustProxy: trustProxyFromEnv(env.ABELE_TRUST_PROXY),
    maxFileBytes: 200 * MB,
    simpleUploadBytes: 8 * MB,
    partBytes: 8 * MB,
    accountTokenTtlMs: HOUR_MS,
    idempotencyTtlMs: 24 * HOUR_MS,
    retentionIntervalMs: 6 * HOUR_MS,
    wsHelloTimeoutMs: 5000,
    scopedSharing: scopedSharingFromEnv(env.ABELE_SCOPED_SHARING),
    configurationDirectories: configurationDirectoriesFromEnv(env.ABELE_CONFIGURATION_DIRS),
  }
}

function scopedSharingFromEnv(raw: string | undefined): boolean {
  if (raw === undefined || raw === 'off') return false
  if (raw === 'on') return true
  throw new Error('ABELE_SCOPED_SHARING must be on or off')
}

function configurationDirectoriesFromEnv(raw: string | undefined): readonly string[] {
  try {
    return registeredConfigurationDirectories(raw === undefined ? [] : JSON.parse(raw))
  } catch {
    throw new Error(
      'ABELE_CONFIGURATION_DIRS must be a bounded JSON array of canonical configuration roots'
    )
  }
}

/** A TCP port: plain decimal digits only, so `0x1F` and `8787abc` are rejected rather than coerced. */
function portFromEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const invalid = new Error(`${name} must be an integer between 1 and 65535`)
  if (!/^\d+$/.test(raw)) throw invalid
  const value = Number(raw)
  if (value < 1 || value > 65535) throw invalid
  return value
}

/**
 * Unset or `false`: the peer is the client. `true`: every hop is trusted. Anything
 * else is a comma-separated list of the proxies' addresses. Only a proxy the
 * operator runs should ever be trusted: a client that reaches the server
 * directly could otherwise name any address it likes and walk around the limits.
 */
function trustProxyFromEnv(raw: string | undefined): boolean | string[] {
  const value = raw?.trim() ?? ''
  if (value === '' || value.toLowerCase() === 'false') return false
  if (value.toLowerCase() === 'true') return true
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}
