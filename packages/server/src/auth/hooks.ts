import { AbeleError } from '@abele/sync-protocol'
import type { FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Kysely } from 'kysely'
import type { Config } from '../config.js'
import type { Database } from '../db/schema.js'
import { authenticateAccount, type AuthDeps } from './accounts.js'
import { authenticateDevice, type DeviceIdentity } from './devices.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAccount`; null on every route that does not ask for one. */
    account: { accountId: string } | null
    /** Set by `requireDevice` and `requireAnyDevice`. */
    device: DeviceIdentity | null
  }
}

/** Account tokens are issued by login; device tokens by enrolment. The prefix says which. */
const ACCOUNT_PREFIX = 'abst_'
const DEVICE_PREFIX = 'absd_'
/** The only scheme the API takes. HTTP compares scheme names case-insensitively. */
const BEARER = 'bearer'

/** The auth functions' dependencies, read out of the app's own. */
export const authDeps = (deps: {
  config: Config
  db: Kysely<Database>
  now?: () => Date
}): AuthDeps => ({
  db: deps.db,
  pepper: deps.config.tokenPepper,
  accountTokenTtlMs: deps.config.accountTokenTtlMs,
  ...(deps.now === undefined ? {} : { now: deps.now }),
})

/** Require an account token: `POST /v1/devices`, `GET /v1/vaults`, and the rest of the account API. */
export function requireAccount(deps: AuthDeps): preHandlerHookHandler {
  return async (request) => {
    const token = bearerToken(request, ACCOUNT_PREFIX, 'an account token is required')
    request.account = await authenticateAccount(deps, token)
  }
}

/** Require a device token without naming a vault: the blob routes, which are vault-agnostic. */
export function requireAnyDevice(deps: AuthDeps): preHandlerHookHandler {
  return async (request) => {
    await deviceOfRequest(deps, request)
  }
}

/** Require a device token whose vault is the `:v` in the path; another vault is forbidden. */
export function requireDevice(deps: AuthDeps): preHandlerHookHandler {
  return async (request) => {
    const device = await deviceOfRequest(deps, request)
    const { v } = request.params as { v?: string }
    if (v !== device.vaultId) {
      throw new AbeleError('forbidden', 'that device belongs to another vault')
    }
  }
}

/** The account a route ran for. The hook has already set it; this keeps the route honest. */
export function accountOf(request: FastifyRequest): { accountId: string } {
  if (!request.account) throw new AbeleError('unauthorized', 'an account token is required')
  return request.account
}

/** The device a route ran for. */
export function deviceOf(request: FastifyRequest): DeviceIdentity {
  if (!request.device) throw new AbeleError('unauthorized', 'a device token is required')
  return request.device
}

async function deviceOfRequest(deps: AuthDeps, request: FastifyRequest): Promise<DeviceIdentity> {
  const token = bearerToken(request, DEVICE_PREFIX, 'a device token is required')
  const device = await authenticateDevice(deps, token)
  request.device = device
  return device
}

/**
 * The bearer token of the kind this route wants. A token of the other kind is
 * `unauthorized` rather than `forbidden`: it is the wrong credential, not a
 * credential short of a right.
 */
function bearerToken(request: FastifyRequest, prefix: string, wanted: string): string {
  const token = bearerOf(request.headers.authorization)
  if (token === null) throw new AbeleError('unauthorized', 'a bearer token is required')
  if (!token.startsWith(prefix)) throw new AbeleError('unauthorized', wanted)
  return token
}

/**
 * The token an `Authorization` header carries, or null when it is not a bearer header.
 * One header has many spellings of one token — the scheme in any case, any run of spaces
 * before the token — so anything that counts tokens (a rate limit) goes through this rather
 * than the header as sent, or each spelling would count as a token of its own.
 */
export function bearerOf(header: string | undefined): string | null {
  const [scheme, ...rest] = (header ?? '').split(' ')
  if (scheme?.toLowerCase() !== BEARER) return null
  return rest.join(' ').trim()
}
