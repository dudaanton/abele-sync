import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { AbeleError } from '@abele/sync-protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { BlobStore } from '../blobs/store.js'
import type { Config } from '../config.js'
import type { Dialect } from '../db/connect.js'
import type { Database } from '../db/schema.js'
import { EventHub } from '../events/hub.js'
import { errorHandler, notFoundHandler } from './errors.js'
import { recordIdempotent } from './idempotency.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerBlobRoutes } from './routes/blobs.js'
import { registerCapabilityRoutes } from './routes/capabilities.js'
import { registerExternalFilesRoutes } from './routes/externalFiles.js'
import { registerFolderGrantRoutes } from './routes/folderGrants.js'
import { registerScopedContentRoutes } from './routes/scopedContent.js'
import { registerScopedUploadRoutes } from './routes/scopedUploads.js'
import { registerScopedHistoryRoutes } from './routes/scopedHistory.js'
import { registerScopedCommitRoutes } from './routes/scopedCommits.js'
import { registerScopedStateRoutes } from './routes/scopedState.js'
import { registerScopedViewRoutes } from './routes/scopedViews.js'
import { registerGroupManagementRoutes } from './routes/groupManagement.js'
import { registerSponsoredAssetRoutes } from './routes/sponsoredAssets.js'
import { registerScopedFence } from './scopedFence.js'
import { registerEventRoutes } from './routes/events.js'
import { registerVaultRoutes } from './routes/vaults.js'

/** Everything the HTTP layer runs on: configuration, storage, and a clock tests can hold still. */
export interface AppDeps {
  config: Config
  db: Kysely<Database>
  dialect: Dialect
  store: BlobStore
  hub: EventHub
  now?: () => Date
}

/** Room for the largest body a route accepts, plus the JSON around it. */
const BODY_OVERHEAD_BYTES = 4096

/** A hello frame is a few dozen bytes; nothing a client says needs more than this. */
const WS_MAX_PAYLOAD_BYTES = 4 * 1024

/** Build the server. Nothing listens yet; the caller decides that. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(deps.config.simpleUploadBytes, deps.config.partBytes) + BODY_OVERHEAD_BYTES,
    // What `request.ip` means, and so what the login rate limit counts by.
    trustProxy: deps.config.trustProxy,
  })

  // Only the routes that ask for it are limited; the sync routes are chatty by design.
  await app.register(rateLimit, { global: false })
  // Before the routes: `{ websocket: true }` means nothing until this is registered.
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } })

  app.decorateRequest('account', null)
  app.decorateRequest('device', null)
  app.decorateRequest('rawBody', null)
  app.decorateRequest('idempotency', null)

  // JSON, parsed here rather than by Fastify, so the bytes survive the parsing:
  // an idempotency key is only worth anything against the request it came with.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8')
    request.rawBody = raw
    if (raw === '') {
      done(new AbeleError('invalid_request', 'the request body is empty'), undefined)
      return
    }
    try {
      done(null, JSON.parse(raw))
    } catch {
      done(new AbeleError('invalid_request', 'the request body could not be read'), undefined)
    }
  })

  // Blob bodies are bytes, not JSON: hand the route the buffer exactly as it arrived.
  app.addContentTypeParser(
    'application/octet-stream',
    {
      parseAs: 'buffer',
      bodyLimit: Math.max(deps.config.simpleUploadBytes, deps.config.partBytes),
    },
    (_request, body, done) => {
      done(null, body)
    }
  )

  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFoundHandler)

  // The other half of `idempotency`: the answer is filed on its way out.
  app.addHook('onSend', recordIdempotent(deps))

  // The liveness probe: no token, no database, nothing but proof that the
  // process is up and answering. A container health check runs it every few
  // seconds, so it must stay this cheap.
  app.get('/healthz', async (_request, reply) => reply.code(200).send({ ok: true }))

  registerScopedFence(app, deps.config.scopedSharing)
  registerCapabilityRoutes(app, deps.config.scopedSharing)
  registerExternalFilesRoutes(app, deps)
  registerAuthRoutes(app, deps)
  registerVaultRoutes(app, deps)
  registerFolderGrantRoutes(app, deps)
  registerScopedContentRoutes(app, deps)
  registerScopedUploadRoutes(app, deps)
  registerScopedHistoryRoutes(app, deps)
  registerScopedCommitRoutes(app, deps)
  registerScopedStateRoutes(app, deps)
  registerScopedViewRoutes(app, deps)
  registerGroupManagementRoutes(app, deps)
  registerSponsoredAssetRoutes(app, deps)
  registerBlobRoutes(app, deps)
  registerEventRoutes(app, deps)

  await app.ready()
  return app
}
