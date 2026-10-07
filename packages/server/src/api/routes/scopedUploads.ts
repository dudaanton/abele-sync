import { AbeleError, ShaSchema } from '@abele/sync-protocol'
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify'
import { z } from 'zod'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import {
  beginScopedUpload,
  completeScopedUpload,
  putScopedPart,
  SCOPED_MULTIPART_LIMITS,
} from '../../scoped/multipart.js'
import { uploadScopedBlob, SCOPED_UPLOAD_LIMITS } from '../../scoped/uploads.js'
import type { AppDeps } from '../app.js'

const begin = z
  .object({ size: z.number().int().positive().max(SCOPED_MULTIPART_LIMITS.maxBytes) })
  .strict()
const bounded =
  (size: number): onRequestHookHandler =>
  async (request) => {
    const raw = request.headers['content-length']
    if (raw !== undefined && (!/^\d+$/.test(raw) || Number(raw) > size))
      throw new AbeleError('too_large', 'scoped part exceeds the negotiated limit')
  }
const body = (request: FastifyRequest): Buffer => {
  if (!Buffer.isBuffer(request.body))
    throw new AbeleError('invalid_request', 'binary body required')
  return request.body
}
const token = (request: FastifyRequest): string => {
  const value = bearerOf(request.headers.authorization)
  if (!value) throw new AbeleError('unauthorized', 'a scoped credential is required')
  return value
}
/** Scoped uploads behind the shared runtime fence. No personal credential fallback. */
export function registerScopedUploadRoutes(app: FastifyInstance, deps: AppDeps): void {
  const scoped = {
    ...authDeps(deps),
    dialect: deps.dialect,
    store: deps.store,
    config: deps.config,
  }
  type Params = { v: string; g: string; sha: string; id: string; part: string }
  const route = '/v1/scoped/vaults/:v/grants/:g/uploads/:sha'
  app.put<{ Params: Params }>(
    route,
    { onRequest: bounded(SCOPED_UPLOAD_LIMITS.maxBlobBytes) },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const { v, g, sha } = request.params
      return reply
        .code(201)
        .send(
          await uploadScopedBlob(scoped, token(request), v, g, ShaSchema.parse(sha), body(request))
        )
    }
  )
  app.post<{ Params: Params }>(`${route}/begin`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const { v, g, sha } = request.params
    const { size } = begin.parse(request.body)
    return reply
      .code(201)
      .send(await beginScopedUpload(scoped, token(request), v, g, ShaSchema.parse(sha), size))
  })
  app.put<{ Params: Params }>(
    `${route}/:id/:part`,
    { onRequest: bounded(SCOPED_MULTIPART_LIMITS.partBytes) },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const { v, g, id, part } = request.params
      await putScopedPart(scoped, token(request), v, g, id, Number(part), body(request))
      return reply.code(204).send()
    }
  )
  app.post<{ Params: Params }>(`${route}/:id/complete`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const { v, g, id } = request.params
    return reply.code(201).send(await completeScopedUpload(scoped, token(request), v, g, id))
  })
}
