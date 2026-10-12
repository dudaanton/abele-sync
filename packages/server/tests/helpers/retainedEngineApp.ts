import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { AbeleError } from '@abele/sync-protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { BlobStore } from '../../src/blobs/store.js'
import type { Config } from '../../src/config.js'
import type { Dialect } from '../../src/db/connect.js'
import type { Database } from '../../src/db/schema.js'
import { EventHub } from '../../src/events/hub.js'
import { errorHandler, notFoundHandler } from '../../src/api/errors.js'
import { recordIdempotent } from '../legacy/src/api/idempotency.js'
import { registerAuthRoutes } from '../legacy/src/api/routes/auth.js'
import { registerBlobRoutes } from '../legacy/src/api/routes/blobs.js'
import { registerCapabilityRoutes } from '../legacy/src/api/routes/capabilities.js'
import { registerExternalFilesRoutes } from '../legacy/src/api/routes/externalFiles.js'
import { registerEventRoutes } from '../legacy/src/api/routes/events.js'
import { registerVaultRoutes } from '../legacy/src/api/routes/vaults.js'

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

/** Test-only old engine transport. Never registered by the public server.
 * Remove this bridge with the stage-2 unified engine adapter. No rollout compatibility. */
export async function buildRetainedEngineTestApp(deps: AppDeps): Promise<FastifyInstance> {
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

  registerCapabilityRoutes(app, false)
  registerExternalFilesRoutes(app, deps)
  registerAuthRoutes(app, deps)
  registerVaultRoutes(app, deps)
  registerBlobRoutes(app, deps)
  registerEventRoutes(app, deps)

  await app.ready()
  return app
}
