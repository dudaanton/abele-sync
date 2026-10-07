import { AbeleError, ScopedCommitRequestSchema } from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import { commitScoped } from '../../scoped/commits.js'
import type { AppDeps } from '../app.js'
/** The scoped protocol version and deployment fence run before this handler. */
export function registerScopedCommitRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Params: { v: string; g: string } }>(
    '/v1/scoped/vaults/:v/grants/:g/commit',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const token = bearerOf(request.headers.authorization)
      if (!token) throw new AbeleError('unauthorized', 'a scoped credential is required')
      const body = ScopedCommitRequestSchema.safeParse(request.body)
      if (!body.success) throw new AbeleError('invalid_request', 'invalid scoped commit')
      return commitScoped(
        {
          ...authDeps(deps),
          dialect: deps.dialect,
          store: deps.store,
          config: deps.config,
          hub: deps.hub,
        },
        token,
        request.params.v,
        request.params.g,
        body.data.request_id,
        body.data.ops
      )
    }
  )
}
