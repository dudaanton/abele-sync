import {
  AbeleError,
  EXTERNAL_FILES_MAX_BYTES,
  EXTERNAL_FILES_VERSION_HEADER,
  requireExternalFilesVersion,
  type ExternalFilesCapabilities,
} from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import { personalHead, verifyPersonalFile, verifyScopedFile } from '../../vault/externalFiles.js'
import type { AppDeps } from '../app.js'

export function registerExternalFilesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const bound = { ...authDeps(deps), dialect: deps.dialect, store: deps.store, config: deps.config }
  app.get('/v1/external-files/capabilities', async (_request, reply) => {
    const capabilities: ExternalFilesCapabilities = {
      extension_version: 1,
      projection_schema: 1,
      personal: true,
      scoped: deps.config.scopedSharing,
      verification: {
        live_head: true,
        sha256: true,
        actual_size: true,
        authorization_rechecked: true,
      },
      max_file_size: Math.min(deps.config.maxFileBytes, EXTERNAL_FILES_MAX_BYTES),
    }
    return reply.header('cache-control', 'no-store').send(capabilities)
  })
  const options = {
    onRequest: async (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply
    ) => {
      reply.header('cache-control', 'no-store')
      requireExternalFilesVersion(request.headers[EXTERNAL_FILES_VERSION_HEADER])
    },
  }
  const credential = (request: import('fastify').FastifyRequest) => {
    const token = bearerOf(request.headers.authorization)
    if (!token) throw new AbeleError('unauthorized', 'a bearer token is required')
    return token
  }
  app.get<{ Params: { v: string; f: string } }>(
    '/v1/vaults/:v/files/:f/head',
    options,
    async (request) => personalHead(bound, credential(request), request.params.v, request.params.f)
  )
  app.post<{ Params: { v: string; f: string } }>(
    '/v1/vaults/:v/files/:f/external/verify',
    options,
    async (request) =>
      verifyPersonalFile(
        bound,
        credential(request),
        request.params.v,
        request.params.f,
        request.body
      )
  )
  app.post<{ Params: { v: string; g: string; f: string } }>(
    '/v1/scoped/vaults/:v/grants/:g/files/:f/external/verify',
    options,
    async (request) =>
      verifyScopedFile(
        bound,
        credential(request),
        request.params.v,
        request.params.g,
        request.params.f,
        request.body
      )
  )
}
