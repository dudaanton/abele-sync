import { AbeleError } from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import { readScopedState } from '../../scoped/state.js'
import { revokeScopedSelf } from '../../scoped/selfRevoke.js'
import type { AppDeps } from '../app.js'
/** Registered behind the scoped protocol version and deployment fence. */
export function registerScopedStateRoutes(app: FastifyInstance, deps: AppDeps) {
  app.delete<{ Params: { v: string; g: string } }>(
    '/v1/scoped/vaults/:v/grants/:g/self',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const token = bearerOf(request.headers.authorization)
      if (!token) throw new AbeleError('unauthorized', 'a scoped credential is required')
      return revokeScopedSelf(
        { ...authDeps(deps), dialect: deps.dialect, config: deps.config },
        token,
        request.params.v,
        request.params.g
      )
    }
  )
  app.get<{ Params: { v: string; g: string } }>(
    '/v1/scoped/vaults/:v/grants/:g/state',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const token = bearerOf(request.headers.authorization)
      if (!token) throw new AbeleError('unauthorized', 'a scoped credential is required')
      return readScopedState(
        { ...authDeps(deps), dialect: deps.dialect, config: deps.config },
        token,
        request.params.v,
        request.params.g
      )
    }
  )
}
