import { createHash } from 'node:crypto'
import {
  AbeleError,
  ShaSchema,
  UploadBeginRequestSchema,
  V2CommitRequestSchema,
  TRASH_RESTORE_MAX,
  PathSchema,
} from '@abele/sync-protocol'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppDeps } from '../app.js'
import { bearerKey, accessDeps } from './v2Tokens.js'
import { authenticateTokenId } from '../../access/tokens.js'
import { activeScope } from '../../access/visibility.js'
import { commitWithToken } from '../../access/commit.js'
import {
  withToken,
  manifestWithToken,
  changesWithToken,
  contentWithToken,
} from '../../access/reads.js'
import { hasRoom, waitOn } from '../../blobs/pending.js'
import { createUploadManager } from '../../blobs/uploads.js'
import { sendBlob } from '../blobResponse.js'
import { historyWithToken, trashWithToken, restoreWithToken } from '../../access/history.js'
import { publishExisting } from '../../access/groups/graph.js'

const page = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  next: z.string().max(4096).optional(),
})
const feed = z.object({
  since: z.coerce.number().int().nonnegative().safe().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  next: z.coerce.number().int().nonnegative().safe().optional(),
})
function bytes(request: FastifyRequest, limit: number) {
  if (!Buffer.isBuffer(request.body))
    throw new AbeleError('invalid_request', 'send application/octet-stream bytes')
  if (request.body.length > limit)
    throw new AbeleError('too_large', 'upload exceeds this route limit')
  return request.body
}
export function registerV2SyncRoutes(app: FastifyInstance, deps: AppDeps) {
  const access = accessDeps(deps)
  const uploads = createUploadManager({
    ...deps,
    authorizeOwner: async (db, owner) => {
      const p = await authenticateTokenId({ ...access, db }, owner.deviceId)
      if (p.space.id !== owner.vaultId) throw new AbeleError('not_found', 'no upload in this space')
      await activeScope({ ...access, db }, p)
    },
  })
  const owner = async (request: FastifyRequest) =>
    withToken(access, bearerKey(request), async (_deps, p) => ({
      vaultId: p.space.id,
      deviceId: p.token.id,
    }))
  app.post('/v2/group-assets', async (request) => {
    const input = z
      .union([
        z.object({ file_id: z.string().min(1).max(200) }).strict(),
        z
          .object({
            path: PathSchema,
            sha: ShaSchema,
            size: z.number().int().nonnegative().safe(),
            mtime: z.number().int().nonnegative().safe(),
          })
          .strict(),
      ])
      .parse(request.body)
    if ('file_id' in input)
      return withToken(access, bearerKey(request), async (access, p) => {
        if (p.scope.kind !== 'group')
          throw new AbeleError('forbidden', 'publication requires a group connection')
        await publishExisting(
          access,
          p.scope,
          input.file_id,
          p.token.id,
          (deps.now?.() ?? new Date()).toISOString()
        )
        return { published: true }
      })
    await withToken(access, bearerKey(request), async (_access, p) => {
      if (p.scope.kind !== 'group' || input.path.toLowerCase().endsWith('.md'))
        throw new AbeleError('forbidden', 'publication requires an attachment and group connection')
    })
    return commitWithToken(
      { ...deps, ...access },
      bearerKey(request),
      [{ op: 'create', ...input }],
      z.string().min(1).max(200).parse(request.headers['idempotency-key']),
      undefined,
      { publication: input },
      true
    )
  })
  app.get('/v2/manifest', async (request) => {
    const q = page.parse(request.query)
    return manifestWithToken(access, bearerKey(request), q.limit, q.next)
  })
  app.get('/v2/changes', async (request) => {
    const q = feed.parse(request.query)
    return changesWithToken(access, bearerKey(request), q.next ?? q.since, q.limit)
  })
  app.post('/v2/commit', async (request) =>
    commitWithToken(
      { ...deps, ...access },
      bearerKey(request),
      V2CommitRequestSchema.parse(request.body).ops,
      z.string().min(1).max(200).parse(request.headers['idempotency-key'])
    )
  )
  app.get<{ Params: { id: string } }>('/v2/files/:id/history', async (request) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        before: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query)
    return historyWithToken(access, bearerKey(request), request.params.id, q)
  })
  app.get('/v2/trash', async (request) => {
    const q = z.object({ path_prefix: z.string().max(4096).optional() }).parse(request.query)
    return trashWithToken(access, bearerKey(request), q.path_prefix)
  })
  app.post<{ Params: { id: string } }>('/v2/files/:id/restore', async (request) => {
    const input = z
      .union([
        z.object({ version_id: z.string().min(1).max(200) }).strict(),
        z.object({ deleted: z.literal(true) }).strict(),
      ])
      .parse(request.body)
    const result = await restoreWithToken(
      { ...deps, ...access },
      bearerKey(request),
      [request.params.id],
      'version_id' in input ? input.version_id : undefined,
      z.string().min(1).max(200).parse(request.headers['idempotency-key'])
    )
    return result.results[0]
  })
  app.post('/v2/trash/restore', async (request) => {
    const input = z
      .object({ file_ids: z.array(z.string().min(1).max(200)).min(1).max(TRASH_RESTORE_MAX) })
      .strict()
      .parse(request.body)
    return restoreWithToken(
      { ...deps, ...access },
      bearerKey(request),
      input.file_ids,
      undefined,
      z.string().min(1).max(200).parse(request.headers['idempotency-key'])
    )
  })
  app.get<{ Params: { id: string } }>(
    '/v2/files/:id/content',
    { exposeHeadRoute: false },
    async (request, reply) => {
      const q = z.object({ version_id: z.string().min(1).max(200).optional() }).parse(request.query)
      const version = await contentWithToken(
        access,
        bearerKey(request),
        request.params.id,
        q.version_id
      )
      return sendBlob(reply, deps.store, version.blob_sha!, request.headers.range)
    }
  )
  app.head<{ Params: { id: string } }>('/v2/files/:id/content', async (request, reply) => {
    const q = z.object({ version_id: z.string().min(1).max(200).optional() }).parse(request.query)
    const version = await contentWithToken(
      access,
      bearerKey(request),
      request.params.id,
      q.version_id
    )
    return reply
      .header('content-length', version.size)
      .header('accept-ranges', 'bytes')
      .code(200)
      .send()
  })
  app.put<{ Params: { sha: string } }>('/v2/uploads/:sha', async (request, reply) => {
    const sha = ShaSchema.parse(request.params.sha)
    const body = bytes(request, deps.config.simpleUploadBytes)
    if (createHash('sha256').update(body).digest('hex') !== sha)
      throw new AbeleError('hash_mismatch', 'uploaded bytes do not match their digest')
    const result = await withToken(access, bearerKey(request), async (access, p) => {
      const settings = JSON.parse(p.space.settings)
      if (body.length > settings.max_file_bytes)
        throw new AbeleError('too_large', 'file exceeds the space limit')
      // Quota and credential are checked under the commit lock; no SHA existence shortcut.
      await hasRoom(
        access.db as import('kysely').Transaction<import('../../db/schema.js').Database>,
        p.space.id,
        sha,
        body.length
      )
      const stored = await deps.store.put(body, sha)
      await waitOn(
        access.db as import('kysely').Transaction<import('../../db/schema.js').Database>,
        {
          vaultId: p.space.id,
          deviceId: p.token.id,
          sha,
          size: body.length,
          at: deps.now?.() ?? new Date(),
        }
      )
      return stored
    })
    return reply.code(201).send(result)
  })
  app.post<{ Params: { sha: string } }>('/v2/uploads/:sha/begin', async (request, reply) => {
    const sha = ShaSchema.parse(request.params.sha)
    const { size, max_part_bytes } = UploadBeginRequestSchema.parse(request.body)
    const who = await owner(request)
    return reply.code(201).send(await uploads.begin(sha, size, who, max_part_bytes))
  })
  app.put<{ Params: { sha: string; id: string; part: string } }>(
    '/v2/uploads/:sha/:id/:part',
    async (request, reply) => {
      ShaSchema.parse(request.params.sha)
      await uploads.putPart(
        request.params.id,
        z.coerce.number().int().nonnegative().parse(request.params.part),
        bytes(request, deps.config.partBytes),
        { ...(await owner(request)), sha: request.params.sha }
      )
      return reply.code(204).send()
    }
  )
  app.post<{ Params: { sha: string; id: string } }>(
    '/v2/uploads/:sha/:id/complete',
    async (request, reply) => {
      ShaSchema.parse(request.params.sha)
      return reply.code(201).send(
        await uploads.complete(request.params.id, {
          ...(await owner(request)),
          sha: request.params.sha,
        })
      )
    }
  )
}
