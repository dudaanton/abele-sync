import {
  ExternalVerifyRequestSchema,
  requireExternalFilesVersion,
  EXTERNAL_FILES_VERSION_HEADER,
} from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app.js'
import { bearerKey, accessDeps } from './v2Tokens.js'
import {
  externalCapabilitiesWithToken,
  headWithToken,
  verifyExternalWithToken,
} from '../../access/externalFiles.js'

export function registerV2ExternalFilesRoutes(app: FastifyInstance, deps: AppDeps) {
  const access = { ...accessDeps(deps), store: deps.store, maxFileBytes: deps.config.maxFileBytes }
  app.get('/v2/external-files/capabilities', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return externalCapabilitiesWithToken(access, bearerKey(request))
  })
  app.get<{ Params: { id: string } }>('/v2/files/:id/head', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    requireExternalFilesVersion(request.headers[EXTERNAL_FILES_VERSION_HEADER])
    return headWithToken(access, bearerKey(request), request.params.id)
  })
  app.post<{ Params: { id: string } }>('/v2/files/:id/external/verify', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    requireExternalFilesVersion(request.headers[EXTERNAL_FILES_VERSION_HEADER])
    return verifyExternalWithToken(
      access,
      bearerKey(request),
      request.params.id,
      ExternalVerifyRequestSchema.parse(request.body)
    )
  })
}
