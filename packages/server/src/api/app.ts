import { registerActivity } from '../history/activity.js'
import { generationPath, restoreGeneration } from '../restoreGeneration.js'
import websocket from '@fastify/websocket'
import { AbeleError, RESTORE_GENERATION_HEADER } from '@abele/sync-protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { BlobStore } from '../blobs/store.js'
import type { Config } from '../config.js'
import type { Dialect } from '../db/connect.js'
import type { Database } from '../db/schema.js'
import type { EventHub } from '../events/hub.js'
import { errorHandler, notFoundHandler } from './errors.js'
import { registerV2TokenRoutes } from './routes/v2Tokens.js'
import { registerV2SyncRoutes } from './routes/v2Sync.js'
import { registerV2EventRoutes } from './routes/v2Events.js'
import { registerV2ExternalFilesRoutes } from './routes/v2ExternalFiles.js'

export interface AppDeps {
  config: Config
  db: Kysely<Database>
  dialect: Dialect
  store: BlobStore
  hub: EventHub
  now?: () => Date
}

/** Public server: one token API, no legacy login/device/vault/scoped compatibility routes. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const generation = await restoreGeneration(deps.db, generationPath(deps.config.blobDir))
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(deps.config.simpleUploadBytes, deps.config.partBytes) + 4096,
    trustProxy: deps.config.trustProxy,
  })
  await app.register(websocket, { options: { maxPayload: 4096 } })
  app.addHook('onRequest', async (request, reply) => {
    reply.header(RESTORE_GENERATION_HEADER, generation.generation)
    const expected = request.headers[RESTORE_GENERATION_HEADER]
    if (expected !== undefined && expected !== generation.generation)
      throw new AbeleError(
        'conflict',
        'server generation changed; reconcile local files before retrying'
      )
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.tokenActivity &&
      reply.statusCode < 300 &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    )
      await generation.checkpoint()
    return payload
  })
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8')
    try {
      if (raw === '') throw new Error('empty body')
      done(null, JSON.parse(raw))
    } catch {
      done(new AbeleError('invalid_request', 'the request body could not be read'), undefined)
    }
  })
  app.addContentTypeParser(
    'application/octet-stream',
    {
      parseAs: 'buffer',
      bodyLimit: Math.max(deps.config.simpleUploadBytes, deps.config.partBytes),
    },
    (_request, body, done) => done(null, body)
  )
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFoundHandler)
  app.get('/healthz', async () => ({ ok: true }))
  app.get('/capabilities', async () => ({ protocol: 2, authentication: 'token' }))
  registerActivity(app, deps)
  registerV2TokenRoutes(app, deps)
  registerV2SyncRoutes(app, deps)
  registerV2ExternalFilesRoutes(app, deps)
  registerV2EventRoutes(app, deps)
  await app.ready()
  return app
}
