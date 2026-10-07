import { z } from 'zod'
import { AbeleError, ScopedCheckpointSchema, ScopedManifestItemSchema } from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import { openFolderSnapshot, readFolderSnapshotPage } from '../../scoped/snapshots.js'
import { pollFolderFeed } from '../../scoped/feed.js'
import { withScopedAuthority } from '../../scoped/authority.js'
import { folderVersionInTransaction } from '../../scoped/admissions.js'
import { authNow } from '../../auth/accounts.js'
import type { AppDeps } from '../app.js'
/** Lean view adapters share the scoped protocol version and deployment fence. */
export function registerScopedViewRoutes(app: FastifyInstance, deps: AppDeps) {
  const scoped = {
    ...authDeps(deps),
    dialect: deps.dialect,
    store: deps.store,
    config: deps.config,
  }
  const base = '/v1/scoped/vaults/:v/grants/:g'
  const token = (authorization: string | undefined) => {
    const value = bearerOf(authorization)
    if (!value) throw new AbeleError('unauthorized', 'a scoped credential is required')
    return value
  }
  app.post<{ Params: { v: string; g: string } }>(`${base}/snapshots`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const body = z
      .object({ limit: z.number().int().min(1).max(1000).optional() })
      .strict()
      .safeParse(request.body ?? {})
    if (!body.success) throw new AbeleError('invalid_request', 'invalid snapshot request')
    return openFolderSnapshot(
      scoped,
      token(request.headers.authorization),
      request.params.v,
      request.params.g,
      body.data.limit
    )
  })
  app.get<{ Params: { v: string; g: string; s: string } }>(
    `${base}/snapshots/:s`,
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const query = z
        .object({ cursor: z.string().min(1).max(4096) })
        .strict()
        .safeParse(request.query)
      if (!query.success) throw new AbeleError('invalid_request', 'invalid snapshot cursor')
      const page = await readFolderSnapshotPage(
        scoped,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        query.data.cursor
      )
      if (page.snapshot_id !== request.params.s)
        throw new AbeleError('not_found', 'snapshot unavailable')
      return page
    }
  )
  app.post<{ Params: { v: string; g: string } }>(`${base}/feed`, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const body = z
      .object({
        checkpoint: ScopedCheckpointSchema,
        limit: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .safeParse(request.body)
    if (!body.success) throw new AbeleError('invalid_request', 'invalid scoped feed request')
    return pollFolderFeed(
      scoped,
      token(request.headers.authorization),
      request.params.v,
      request.params.g,
      body.data.checkpoint,
      body.data.limit
    )
  })
  app.get<{ Params: { v: string; g: string; f: string } }>(
    `${base}/files/:f/head`,
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return withScopedAuthority(
        scoped,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        'read',
        async (tx, a) => {
          const item = await tx
            .selectFrom('scope_current_members')
            .select(['file_id', 'version_id', 'path', 'kind', 'sha', 'size', 'mtime'])
            .where('vault_id', '=', request.params.v)
            .where('grant_id', '=', request.params.g)
            .where('file_id', '=', request.params.f)
            .executeTakeFirst()
          if (!item || item.sha === null) throw new AbeleError('not_found', 'no authorized head')
          await folderVersionInTransaction(
            tx,
            a,
            item.file_id,
            item.version_id,
            authNow(scoped),
            scoped
          )
          return ScopedManifestItemSchema.parse(item)
        }
      )
    }
  )
}
