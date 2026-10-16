import { recordUse } from '../../history/activity.js'
import {
  AbeleError,
  V2IssueTokenRequestSchema,
  V2_CAPABILITIES_HEADER,
  V2_READ_ONLY_CAPABILITY,
} from '@abele/sync-protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  authenticateToken,
  findTokenByKey,
  requireWrite,
  connection,
  issueToken,
  listTokens,
  revokeToken,
  type AccessDeps,
} from '../../access/tokens.js'
import { DELETE_SCOPE_REQUEST_HASH } from '../../oplog/keyed.js'
import type { AppDeps } from '../app.js'

declare module 'fastify' {
  interface FastifyRequest {
    scopeDeletionReplay?: boolean
  }
}

export function bearerKey(request: FastifyRequest): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')
  if (match === null) throw new AbeleError('unauthorized', 'missing or invalid access token')
  return match[1]!
}
export function accessDeps(deps: AppDeps): AccessDeps {
  return {
    db: deps.db,
    pepper: deps.config.tokenPepper,
    dialect: deps.dialect,
    configurationDirectories: deps.config.configurationDirectories,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  }
}
function tokenResponse<T extends { read_only?: boolean }>(
  request: FastifyRequest,
  value: T,
  explicit = false
): T {
  const capabilities = request.headers[V2_CAPABILITIES_HEADER]
  if (
    explicit ||
    (typeof capabilities === 'string' &&
      capabilities.split(',').some((c) => c.trim() === V2_READ_ONLY_CAPABILITY))
  )
    return value
  const legacy = { ...value }
  delete legacy.read_only
  return legacy
}
export function registerV2TokenRoutes(app: FastifyInstance, deps: AppDeps): void {
  const access = accessDeps(deps)
  // Before parsing or routing, including idempotency replays and unknown v2 routes.
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]
    if (
      path === '/v2/events' &&
      request.headers.upgrade?.toLowerCase() === 'websocket' &&
      !request.headers.authorization
    )
      return // hello authenticates before subscribing
    // Only this exact endpoint verifies secret-bound self-deletion receipts before live auth.
    if (path === '/v2/connection/delete' && request.method === 'POST') {
      const key = bearerKey(request)
      const token = await findTokenByKey(access, key)
      if (token.revoked_at !== null) {
        const idem = request.headers['idempotency-key']
        const receipt =
          typeof idem === 'string'
            ? await access.db
                .selectFrom('idempotency')
                .select('request_hash')
                .where('actor_id', '=', token.id)
                .where('key', '=', idem)
                .executeTakeFirst()
            : undefined
        if (receipt?.request_hash !== DELETE_SCOPE_REQUEST_HASH)
          await authenticateToken(access, key)
        else request.scopeDeletionReplay = token.scope_deleted_at !== null
      }
      if (token.revoked_at === null)
        await recordUse(deps, request, await authenticateToken(access, key))
      return
    }
    if (path?.startsWith('/v2/')) {
      const p = await authenticateToken(access, bearerKey(request))
      await recordUse(deps, request, p)
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        path !== '/v2/tokens' &&
        !/^\/v2\/tokens\/[^/]+$/.test(path) &&
        !/^\/v2\/files\/[^/]+\/external\/verify$/.test(path)
      )
        requireWrite(p)
    }
  })
  app.get('/v2/connection', async (request) =>
    tokenResponse(
      request,
      await connection(access, await authenticateToken(access, bearerKey(request)))
    )
  )
  app.get('/v2/tokens', async (request) => ({
    items: (await listTokens(access, bearerKey(request))).map((item) =>
      tokenResponse(request, item)
    ),
  }))
  app.post('/v2/tokens', async (request, reply) => {
    const input = V2IssueTokenRequestSchema.parse(request.body)
    const result = await issueToken(access, bearerKey(request), input)
    return reply
      .code(201)
      .send({ ...result, info: tokenResponse(request, result.info, input.read_only !== undefined) })
  })
  app.delete<{ Params: { id: string } }>('/v2/tokens/:id', async (request) => {
    await revokeToken(access, bearerKey(request), request.params.id)
    deps.hub.hangUp(request.params.id, 4001)
    return { revoked: true }
  })
}
