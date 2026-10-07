import { AbeleError, SCOPED_VERSION_HEADER, requireScopedVersion } from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'

/** Default closed policy; deployments can enable only the entire runtime. */
export const SCOPED_RUNTIME_FENCES = Object.freeze({
  folder: false,
  group: false,
  management: false,
  publication: false,
})
const sync = /^\/v1\/scoped(?:\/|$)/
const management = /^\/v1\/(?:grants|invitations)(?:\/|$)|^\/v1\/vaults\/[^/]+\/grants(?:\/|$)/

/** Before parsing bodies, credentials, idempotency or any parked route handler. */
export function registerScopedFence(app: FastifyInstance, enabled = false): void {
  app.addHook('onRequest', async (request, reply) => {
    const raw = (request.raw.url ?? '').split('?')[0]!
    let path = raw
    try {
      path = decodeURIComponent(raw)
    } catch {
      /* malformed routes cannot gain authority */
    }
    const route = request.routeOptions.url ?? ''
    const scopedSync = sync.test(path) || sync.test(route)
    if (!scopedSync && !management.test(path) && !management.test(route)) return
    reply.header('Cache-Control', 'no-store')
    if (scopedSync) requireScopedVersion(request.headers[SCOPED_VERSION_HEADER])
    if (!enabled)
      throw new AbeleError('scoped_unavailable', 'scoped sync and management are not enabled')
  })
}
