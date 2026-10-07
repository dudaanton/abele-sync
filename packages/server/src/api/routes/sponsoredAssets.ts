import { AbeleError, ShaSchema } from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import {
  readSponsoredAssets,
  addSponsoredAsset,
  mutateSponsoredAssets,
} from '../../scoped/assets.js'
import { readScopedUploadProof, createNativeSponsoredAsset } from '../../scoped/nativeAssets.js'
import { readIntrinsicSponsorProof } from '../../scoped/sponsorProof.js'
import { readTargetVisibility } from '../../scoped/targetVisibility.js'
import type { AppDeps } from '../app.js'
/** Explicit delta/native APIs; the deployment fence runs first. */
export function registerSponsoredAssetRoutes(app: FastifyInstance, deps: AppDeps) {
  const bound = {
    ...authDeps(deps),
    dialect: deps.dialect,
    store: deps.store,
    config: deps.config,
    hub: deps.hub,
  }
  const token = (header: string | undefined) => {
    const bearer = bearerOf(header)
    if (!bearer) throw new AbeleError('unauthorized', 'a bound credential is required')
    return bearer
  }
  const owner = '/v1/vaults/:v/grants/:g/assets',
    scoped = '/v1/scoped/vaults/:v/grants/:g'
  app.get<{ Params: { v: string; g: string; fileId: string } }>(
    `${owner}/visibility/:fileId`,
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return readTargetVisibility(
        bound,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        request.params.fileId
      )
    }
  )
  for (const path of [owner, `${scoped}/assets`])
    app.get<{ Params: { v: string; g: string } }>(path, async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return readSponsoredAssets(
        bound,
        token(request.headers.authorization),
        request.params.v,
        request.params.g
      )
    })
  for (const path of [`${owner}/sponsors/:f/proof`, `${scoped}/assets/sponsors/:f/proof`])
    app.get<{ Params: { v: string; g: string; f: string } }>(path, async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return readIntrinsicSponsorProof(
        bound,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        request.params.f,
        path.startsWith('/v1/scoped/') ? 'scoped' : 'owner'
      )
    })
  app.post<{ Params: { v: string; g: string } }>(`${owner}/add`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return addSponsoredAsset(
      bound,
      token(request.headers.authorization),
      request.params.v,
      request.params.g,
      request.body
    )
  })
  app.post<{ Params: { v: string; g: string } }>(`${owner}/mutate`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return mutateSponsoredAssets(
      bound,
      token(request.headers.authorization),
      request.params.v,
      request.params.g,
      request.body
    )
  })
  app.get<{ Params: { v: string; g: string; sha: string } }>(
    `${scoped}/uploads/:sha/proof`,
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return readScopedUploadProof(
        bound,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        ShaSchema.parse(request.params.sha)
      )
    }
  )
  app.post<{ Params: { v: string; g: string } }>(
    `${scoped}/assets/native`,
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return createNativeSponsoredAsset(
        bound,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        request.body
      )
    }
  )
}
