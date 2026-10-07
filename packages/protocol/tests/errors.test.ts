import { describe, it, expect } from 'vitest'
import { AbeleError, ERROR_STATUS } from '../src/errors.js'

describe('AbeleError', () => {
  it('carries code, status and details', () => {
    const e = new AbeleError('invalid_path', 'bad path', { path: 'a:b' })
    expect(e.code).toBe('invalid_path')
    expect(e.status).toBe(400)
    expect(e.details).toEqual({ path: 'a:b' })
    expect(e.message).toBe('bad path')
    expect(e.toBody()).toEqual({
      error: { code: 'invalid_path', message: 'bad path', details: { path: 'a:b' } },
    })
  })
  it('maps every code to a status', () => {
    for (const status of Object.values(ERROR_STATUS)) expect(status).toBeGreaterThanOrEqual(400)
    expect(ERROR_STATUS.unauthorized).toBe(401)
    expect(ERROR_STATUS.forbidden).toBe(403)
    expect(ERROR_STATUS.not_found).toBe(404)
    expect(ERROR_STATUS.stale_base).toBe(412)
    expect(ERROR_STATUS.too_large).toBe(413)
    expect(ERROR_STATUS.rate_limited).toBe(429)
    expect(ERROR_STATUS.path_taken).toBe(409)
    expect(ERROR_STATUS.case_collision).toBe(409)
    expect(ERROR_STATUS.hash_mismatch).toBe(400)
    expect(ERROR_STATUS.quota_exceeded).toBe(413)
    expect(ERROR_STATUS.internal).toBe(500)
  })
})
