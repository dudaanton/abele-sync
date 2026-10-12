import { AbeleError, V2IssueTokenRequestSchema } from '@abele/sync-protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  authenticateToken,
  connection,
  issueToken,
  listTokens,
  revokeToken,
  type AccessDeps,
} from '../../access/tokens.js'
import type { AppDeps } from '../app.js'

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
    if (path?.startsWith('/v2/')) await authenticateToken(access, bearerKey(request))
  })
  app.get('/v2/connection', async (request) =>
    connection(access, await authenticateToken(access, bearerKey(request)))
  )
  app.get('/v2/tokens', async (request) => ({
    items: await listTokens(access, bearerKey(request)),
  }))
  app.post('/v2/tokens', async (request, reply) =>
    reply
      .code(201)
      .send(
        await issueToken(access, bearerKey(request), V2IssueTokenRequestSchema.parse(request.body))
      )
  )
  app.delete<{ Params: { id: string } }>('/v2/tokens/:id', async (request) => {
    await revokeToken(access, bearerKey(request), request.params.id)
    deps.hub.hangUp(request.params.id, 4001)
    return { revoked: true }
  })
}
