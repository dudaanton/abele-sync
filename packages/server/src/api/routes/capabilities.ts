import {
  PROTOCOL_VERSION,
  SCOPED_PROTOCOL_VERSION,
  SCOPED_REQUIRED_CAPABILITIES,
  SCOPED_LIMITS,
  type CapabilitiesResponse,
} from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'

/** Advertisement and route activation use the same deployment setting. */
export function registerCapabilityRoutes(app: FastifyInstance, enabled = false): void {
  app.get('/v1/capabilities', async (_request, reply) => {
    const capabilities: CapabilitiesResponse = {
      protocol_version: PROTOCOL_VERSION,
      device: true,
      scoped: enabled
        ? {
            enabled: true,
            protocol_version: SCOPED_PROTOCOL_VERSION,
            modes: { folder: true, group: true },
            features: Object.fromEntries(
              SCOPED_REQUIRED_CAPABILITIES.map((name) => [name, true])
            ) as Record<(typeof SCOPED_REQUIRED_CAPABILITIES)[number], true>,
            limits: SCOPED_LIMITS,
          }
        : { enabled: false },
    }
    return reply.header('Cache-Control', 'no-store').send(capabilities)
  })
}
