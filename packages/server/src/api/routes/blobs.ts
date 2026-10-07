import {
  AbeleError,
  UploadBeginRequestSchema,
  type UploadBeginResponse,
} from '@abele/sync-protocol'
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify'
import { authDeps, deviceOf, requireAnyDevice } from '../../auth/hooks.js'
import { admitUpload, withdrawUpload, type UploadOwner } from '../../blobs/pending.js'
import { createUploadManager } from '../../blobs/uploads.js'
import type { AppDeps } from '../app.js'
import { CACHE_CONTROL, OCTET_STREAM, sendBlob } from '../blobResponse.js'

const SHA256_HEX = /^[0-9a-f]{64}$/

/** What a stored blob answers with: the name it is filed under and the size of its plaintext. */
interface BlobStored {
  sha: string
  size: number
}

/**
 * Blobs: the content every version points at. The store is one for the whole
 * server — a blob is named by its own hash, the same in every vault — but the
 * routes answer for one vault: a blob exists for a vault once a version of that
 * vault names it. Until then, HEAD and GET are 404 even for the device that
 * uploaded it, and a PUT is 201 whether the bytes were there or not. A device
 * therefore learns nothing about what other vaults hold, not even by hash.
 *
 * The upload manager is held here rather than on the app: the only caller
 * inside a request is this module, and retention builds its own with
 * `createUploadManager`.
 */
export function registerBlobRoutes(app: FastifyInstance, deps: AppDeps): void {
  const device = requireAnyDevice(authDeps(deps))
  const uploads = createUploadManager(deps)
  const { simpleUploadBytes, partBytes } = deps.config
  const now = deps.now ?? (() => new Date())

  /** The vault an upload counts against and the device that will commit it. */
  const ownerOf = (request: FastifyRequest): UploadOwner => {
    const { vaultId, deviceId } = deviceOf(request)
    return { vaultId, deviceId }
  }

  /** The sha in the path, if a version of this device's vault names it; `not_found` otherwise. */
  const visibleSha = async (request: FastifyRequest<{ Params: BlobParams }>): Promise<string> => {
    const sha = shaOf(request.params)
    const named = await deps.db
      .selectFrom('versions')
      .select('id')
      .where('vault_id', '=', deviceOf(request).vaultId)
      .where('blob_sha', '=', sha)
      .limit(1)
      .executeTakeFirst()
    if (named === undefined) throw new AbeleError('not_found', `no blob ${sha}`)
    return sha
  }

  app.head<{ Params: BlobParams }>(
    '/v1/blobs/:sha',
    { preHandler: device },
    async (request, reply) => {
      const sha = await visibleSha(request)
      // A version names it but the bytes are not there: retention's window, or a lost disk.
      if (!(await deps.store.has(sha))) throw new AbeleError('not_found', `no blob ${sha}`)
      return reply
        .code(204)
        .header('accept-ranges', 'bytes')
        .header('cache-control', CACHE_CONTROL)
        .send()
    }
  )

  app.get<{ Params: BlobParams }>(
    '/v1/blobs/:sha',
    // The HEAD above is this route's own; Fastify must not add a second one.
    { preHandler: device, exposeHeadRoute: false },
    async (request, reply) =>
      sendBlob(reply, deps.store, await visibleSha(request), request.headers.range)
  )

  app.put<{ Params: BlobParams; Reply: BlobStored }>(
    '/v1/blobs/:sha',
    { preHandler: device, onRequest: refuseOversize(simpleUploadBytes) },
    async (request, reply) => {
      const sha = shaOf(request.params)
      const body = bodyBytes(request)
      // A body with no content-length got past the header check; measure what actually arrived.
      if (body.length > simpleUploadBytes) throw oversize(body.length, simpleUploadBytes)
      // Proven before anything is counted: a body that is not these bytes changes no count,
      // and the size counted is the sha's own.
      const actual = createHash('sha256').update(body).digest('hex')
      if (actual !== sha) {
        throw new AbeleError(
          'hash_mismatch',
          'the bytes do not hash to the sha they were sent under',
          {
            expected: sha,
            actual,
          }
        )
      }
      // Counted against the vault before a byte of it is kept (`blobs/pending.ts`).
      const owner = ownerOf(request)
      const fresh = await admitUpload(deps, { ...owner, sha, size: body.length, at: now() })
      try {
        // Whether the bytes were already there is the store's business, never the answer's.
        const { size } = await deps.store.put(body, sha)
        return reply.code(201).send({ sha, size })
      } catch (error) {
        if (fresh) await withdrawUpload(deps.db, { ...owner, sha })
        throw error
      }
    }
  )

  app.post<{ Params: BlobParams; Reply: UploadBeginResponse }>(
    '/v1/blobs/:sha/upload',
    { preHandler: device },
    async (request, reply) => {
      const sha = shaOf(request.params)
      const { size } = UploadBeginRequestSchema.parse(request.body)
      // Counted from the start: the parts sit on the disk long before the blob does.
      return reply.code(201).send(await uploads.begin(sha, size, ownerOf(request)))
    }
  )

  app.put<{ Params: PartParams }>(
    '/v1/blobs/:sha/upload/:id/:part',
    { preHandler: device, onRequest: refuseOversize(partBytes) },
    async (request, reply) => {
      shaOf(request.params)
      await uploads.putPart(
        request.params.id,
        Number(request.params.part),
        bodyBytes(request),
        ownerOf(request)
      )
      return reply.code(204).send()
    }
  )

  app.post<{ Params: UploadParams; Reply: BlobStored }>(
    '/v1/blobs/:sha/upload/:id/complete',
    { preHandler: device },
    async (request, reply) => {
      shaOf(request.params)
      // Counted since `begin`; completing turns the upload into bytes waiting for a commit.
      return reply.code(201).send(await uploads.complete(request.params.id, ownerOf(request)))
    }
  )
}

interface BlobParams {
  sha: string
}
interface UploadParams extends BlobParams {
  id: string
}
interface PartParams extends UploadParams {
  part: string
}

/** The sha in the path, or nothing: an unhashable name could never match a blob anyway. */
function shaOf(params: BlobParams): string {
  if (!SHA256_HEX.test(params.sha)) {
    throw new AbeleError(
      'invalid_request',
      'a blob is named by the 64 hex characters of its sha-256'
    )
  }
  return params.sha
}

/** The raw body of an octet-stream request. */
function bodyBytes(request: FastifyRequest): Buffer {
  const body: unknown = request.body
  if (!Buffer.isBuffer(body)) {
    throw new AbeleError('invalid_request', `send the bytes as ${OCTET_STREAM}`)
  }
  return body
}

/**
 * Refuse a body the route could not accept before reading a byte of it. A
 * client that declares nothing still gets measured after parsing, but an honest
 * one is turned away at the door rather than after megabytes.
 */
function refuseOversize(limit: number): onRequestHookHandler {
  return async (request) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) throw oversize(declared, limit)
  }
}

const oversize = (size: number, limit: number): AbeleError =>
  new AbeleError('too_large', 'that body is larger than this route accepts', {
    size,
    max_bytes: limit,
  })
