import { AbeleError } from '@abele/sync-protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import { readScopedCurrent, type ScopedCurrentTarget } from '../../scoped/content.js'
import type { AppDeps } from '../app.js'

/** All external scoped paths remain behind registerScopedFence. No environment override.
 * no-store is set before authentication/lookup so refusals cannot be cached either.
 */
export function registerScopedContentRoutes(app: FastifyInstance, deps: AppDeps): void {
  const scoped = {
    ...authDeps(deps),
    dialect: deps.dialect,
    store: deps.store,
    config: deps.config,
  }
  type Params = { v: string; g: string; f?: string; sha?: string }
  const handle =
    (method: 'GET' | 'HEAD') =>
    async (request: FastifyRequest<{ Params: Params }>, reply: import('fastify').FastifyReply) => {
      reply.header('cache-control', 'no-store')
      const token = bearerOf(request.headers.authorization)
      if (!token) throw new AbeleError('unauthorized', 'a scoped credential is required')
      const target: ScopedCurrentTarget =
        request.params.f === undefined
          ? { sha: request.params.sha! }
          : { file_id: request.params.f }
      const response = await readScopedCurrent(
        scoped,
        token,
        request.params.v,
        request.params.g,
        target,
        {
          method,
          range: request.headers.range,
          ifNoneMatch: request.headers['if-none-match'],
          ifRange: Array.isArray(request.headers['if-range'])
            ? request.headers['if-range'].join(',')
            : request.headers['if-range'],
        }
      )
      for (const [name, value] of Object.entries(response.headers)) reply.header(name, value)
      return reply.code(response.status).send(response.body)
    }
  for (const suffix of ['files/:f/current', 'blobs/:sha']) {
    const path = `/v1/scoped/vaults/:v/grants/:g/${suffix}`
    app.head<{ Params: Params }>(path, handle('HEAD'))
    app.get<{ Params: Params }>(path, { exposeHeadRoute: false }, handle('GET'))
  }
}
