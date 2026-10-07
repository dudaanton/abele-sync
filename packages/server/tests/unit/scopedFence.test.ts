import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerScopedFence, SCOPED_RUNTIME_FENCES } from '../../src/api/scopedFence.js'

it('keeps every intermediate runtime fence closed', () => {
  expect(SCOPED_RUNTIME_FENCES).toEqual({
    folder: false,
    group: false,
    management: false,
    publication: false,
  })
  expect(Object.isFrozen(SCOPED_RUNTIME_FENCES)).toBe(true)
})

describe('future route registration cannot bypass the closed fence', () => {
  it('blocks handlers for every method, including owner management and encoded paths', async () => {
    const app = Fastify()
    registerScopedFence(app)
    let called = 0
    for (const url of [
      '/v1/scoped/grants/:g/state',
      '/v1/vaults/:v/grants/:g/extras',
      '/v1/grants',
      '/v1/invitations/accept',
    ]) {
      app.route({
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        url,
        handler: async () => {
          called++
          return { private: 'must not run' }
        },
      })
    }
    try {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
        for (const url of [
          '/v1/scoped/grants/g/state',
          '/v1/vaults/v/grants/g/extras',
          '/v1/grants',
          '/v1/invitations/accept',
          '/v1/vaults/v/gr%61nts/g/extras',
        ]) {
          const response = await app.inject({
            method,
            url,
            headers: { 'x-abele-scoped-version': '4' },
          })
          expect(response.statusCode, `${method} ${url}`).toBe(503)
          expect(response.headers['cache-control']).toBe('no-store')
        }
      }
      expect(called).toBe(0)
    } finally {
      await app.close()
    }
  })
})
