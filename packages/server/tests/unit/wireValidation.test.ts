import Fastify from 'fastify'
import { V2CommitRequestSchema } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import { errorHandler } from '../../src/api/errors.js'

it('keeps protocol Zod errors in the public invalid_request envelope with bounded array issues', async () => {
  const app = Fastify({ logger: false })
  app.setErrorHandler(errorHandler)
  app.post('/validate', async (request) => V2CommitRequestSchema.parse(request.body))
  try {
    const oversized = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: { ops: Array(1001).fill(null) },
    })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.headers['x-abele-error-code']).toBe('invalid_request')
    expect(oversized.json().error).toMatchObject({
      code: 'invalid_request',
      message: 'the request body is not valid',
    })
    expect(oversized.json().error.details.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['ops'], maximum: 1000 }),
    ])
    expect(oversized.body.length).toBeLessThan(1024)
    const malformed = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: { ops: [{ op: 'unknown' }] },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error.details.issues).toEqual([
      expect.objectContaining({ code: 'invalid_union', path: ['ops', 0] }),
    ])
    expect(JSON.stringify(malformed.json())).not.toContain('stack')
  } finally {
    await app.close()
  }
})
