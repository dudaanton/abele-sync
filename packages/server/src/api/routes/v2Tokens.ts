import { addItem, removeItem, listItems, itemCounts } from '../../access/items.js'
import { previewTokenContent } from '../../access/contentPreview.js'
import { recordUse } from '../../history/activity.js'
import {
  AbeleError,
  V2IssueTokenRequestSchema,
  V2AddScopeItemRequestSchema,
  V2_CAPABILITIES_HEADER,
  V2_READ_ONLY_CAPABILITY,
  V2_TOKEN_ITEM_COUNT_CAPABILITY,
  V2ContentPreviewQuerySchema,
} from '@abele/sync-protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  authenticateToken,
  authenticateTokenForInventory,
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
export function accessDeps(deps: AppDeps, request?: FastifyRequest): AccessDeps {
  const item = request?.headers['abele-scope-item']
  if (item !== undefined && (typeof item !== 'string' || !item || item.length > 200))
    throw new AbeleError('forbidden', 'scope_removed', { reason: 'scope_removed' })
  return {
    ...(typeof item === 'string' ? { itemId: item } : {}),
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
  // Before parsing or routing, including idempotency replays and unknown v2 routes.
  app.addHook('onRequest', async (request) => {
    const access = accessDeps(deps, request)
    const path = request.url.split('?')[0]
    if (
      path === '/v2/events' &&
      request.headers.upgrade?.toLowerCase() === 'websocket' &&
      !request.headers.authorization
    )
      return // hello authenticates before subscribing
    // Only this exact endpoint verifies secret-bound self-deletion receipts before live auth.
    if (
      path === '/v2/connection/delete' &&
      request.method === 'POST' &&
      access.itemId === undefined
    ) {
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
      const authenticate =
        path === '/v2/connection/items' && request.method === 'GET'
          ? authenticateTokenForInventory
          : authenticateToken
      const p = await authenticate(access, bearerKey(request))
      await recordUse(deps, request, p)
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        path !== '/v2/tokens' &&
        !/^\/v2\/tokens\/[^/]+(?:\/items(?:\/[^/]+)?)?$/.test(path) &&
        !/^\/v2\/files\/[^/]+\/external\/verify$/.test(path)
      )
        requireWrite(p)
    }
  })
  app.get('/v2/connection', async (request) =>
    tokenResponse(
      request,
      await connection(
        accessDeps(deps, request),
        await authenticateToken(accessDeps(deps, request), bearerKey(request))
      )
    )
  )
  app.get('/v2/connection/items', async (request) =>
    listItems(accessDeps(deps, request), bearerKey(request))
  )
  app.get<{ Params: { id: string } }>('/v2/tokens/:id/items', async (request) =>
    listItems(accessDeps(deps, request), bearerKey(request), request.params.id)
  )
  app.get<{ Params: { id: string; item: string } }>(
    '/v2/tokens/:id/items/:item/preview',
    async (request) => {
      const { limit } = V2ContentPreviewQuerySchema.parse(request.query)
      return (
        await previewTokenContent(
          accessDeps(deps, request),
          bearerKey(request),
          request.params.id,
          limit,
          request.params.item
        )
      ).items[0]!
    }
  )
  app.get<{ Params: { id: string } }>('/v2/tokens/:id/preview', async (request) => {
    const { limit } = V2ContentPreviewQuerySchema.parse(request.query)
    return previewTokenContent(
      accessDeps(deps, request),
      bearerKey(request),
      request.params.id,
      limit
    )
  })
  app.post<{ Params: { id: string } }>('/v2/tokens/:id/items', async (request, reply) => {
    const input = V2AddScopeItemRequestSchema.parse(request.body)
    return reply
      .code(201)
      .send(
        await addItem(accessDeps(deps, request), bearerKey(request), request.params.id, input.scope)
      )
  })
  app.delete<{ Params: { id: string; item: string } }>(
    '/v2/tokens/:id/items/:item',
    async (request) =>
      removeItem(
        accessDeps(deps, request),
        bearerKey(request),
        request.params.id,
        request.params.item
      )
  )
  app.get('/v2/tokens', async (request) => {
    const access = accessDeps(deps, request)
    const tokens = await listTokens(access, bearerKey(request))
    const capabilities = request.headers[V2_CAPABILITIES_HEADER]
    const counts =
      typeof capabilities === 'string' &&
      capabilities.split(',').some((value) => value.trim() === V2_TOKEN_ITEM_COUNT_CAPABILITY)
        ? await itemCounts(
            access,
            tokens.map((token) => token.id)
          )
        : undefined
    return {
      items: tokens.map((token) => ({
        ...tokenResponse(request, token),
        ...(counts ? { item_count: counts.get(token.id)! } : {}),
      })),
    }
  })
  app.post('/v2/tokens', async (request, reply) => {
    const input = V2IssueTokenRequestSchema.parse(request.body)
    const result = await issueToken(accessDeps(deps, request), bearerKey(request), input)
    return reply
      .code(201)
      .send({ ...result, info: tokenResponse(request, result.info, input.read_only !== undefined) })
  })
  app.delete<{ Params: { id: string } }>('/v2/tokens/:id', async (request) => {
    await revokeToken(accessDeps(deps, request), bearerKey(request), request.params.id)
    deps.hub.hangUp(request.params.id, 4001)
    return { revoked: true }
  })
}
