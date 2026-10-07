import { AbeleError } from '@abele/sync-protocol'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import {
  listFolderHistory,
  listFolderTrash,
  readFolderHistoricalVersion,
} from '../../scoped/history.js'
import type { AppDeps } from '../app.js'

const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict()
const token = (request: FastifyRequest) => {
  const value = bearerOf(request.headers.authorization)
  if (!value) throw new AbeleError('unauthorized', 'a scoped credential is required')
  return value
}
/** Registered behind the scoped protocol version and deployment fence. */
export function registerScopedHistoryRoutes(app: FastifyInstance, deps: AppDeps): void {
  const scoped = {
    ...authDeps(deps),
    dialect: deps.dialect,
    store: deps.store,
    config: deps.config,
  }
  type Params = { v: string; g: string; f: string; ver: string }
  const base = '/v1/scoped/vaults/:v/grants/:g'
  app.get<{ Params: Params }>(`${base}/files/:f/versions`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const q = query.parse(request.query)
    return reply.send(
      await listFolderHistory(
        scoped,
        token(request),
        request.params.v,
        request.params.g,
        request.params.f,
        q.limit,
        q.cursor
      )
    )
  })
  app.get<{ Params: Params }>(`${base}/trash`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const q = query.parse(request.query)
    return reply.send(
      await listFolderTrash(
        scoped,
        token(request),
        request.params.v,
        request.params.g,
        q.limit,
        q.cursor
      )
    )
  })
  const bytes =
    (method: 'GET' | 'HEAD') =>
    async (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store')
      const { v, g, f, ver } = request.params
      const response = await readFolderHistoricalVersion(scoped, token(request), v, g, f, ver, {
        method,
        range: request.headers.range,
        ifNoneMatch: request.headers['if-none-match'],
        ifRange: Array.isArray(request.headers['if-range'])
          ? request.headers['if-range'].join(',')
          : request.headers['if-range'],
      })
      for (const [name, value] of Object.entries(response.headers)) reply.header(name, value)
      return reply.code(response.status).send(response.body)
    }
  app.head<{ Params: Params }>(`${base}/files/:f/versions/:ver`, bytes('HEAD'))
  app.get<{ Params: Params }>(
    `${base}/files/:f/versions/:ver`,
    { exposeHeadRoute: false },
    bytes('GET')
  )
}
