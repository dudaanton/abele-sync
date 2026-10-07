import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, newToken, hashToken } from '../../src/auth/hash.js'

describe('passwords', () => {
  it('round-trips and salts', async () => {
    const a = await hashPassword('secret')
    const b = await hashPassword('secret')
    expect(a).not.toBe(b)
    expect(a.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('secret', a)).toBe(true)
    expect(await verifyPassword('wrong', a)).toBe(false)
    expect(await verifyPassword('secret', 'garbage')).toBe(false)
  })

  it('returns false rather than throwing on every malformed stored value', async () => {
    const stored = [
      '',
      'scrypt$',
      'scrypt$abc',
      'bcrypt$YWJj$YWJj',
      'scrypt$$',
      'scrypt$YWJj$YWJj$YWJj',
    ]
    for (const s of stored) expect(await verifyPassword('secret', s)).toBe(false)
  })
})

describe('tokens', () => {
  it('have a prefix and 43 url-safe chars', () => {
    const t = newToken('absd')
    expect(t).toMatch(/^absd_[A-Za-z0-9_-]{43}$/)
    expect(newToken('absd')).not.toBe(t)
  })

  it('hash with the pepper', () => {
    expect(hashToken('p', 'x')).not.toBe(hashToken('q', 'x'))
    expect(hashToken('p', 'x')).toMatch(/^[0-9a-f]{64}$/)
  })
})
