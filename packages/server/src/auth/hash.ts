import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing and the shape of the bearer tokens the API hands out.
 * Passwords are stored as `scrypt$<saltB64>$<hashB64>`; tokens are stored only
 * as a peppered SHA-256 digest, so a stolen database yields no usable token.
 */

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const SALT_BYTES = 32
const KEY_BYTES = 32
const TOKEN_BYTES = 32

export type TokenPrefix = 'abst' | 'absd' | 'absk' | 'absi' | 'absinv'

/** Hash a password with a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

/** Check a password against a stored hash. Anything malformed is a mismatch, never a throw. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$')
    if (parts.length !== 3) return false
    const [scheme, saltB64, keyB64] = parts as [string, string, string]
    if (scheme !== 'scrypt') return false

    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(keyB64, 'base64')
    if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false

    const actual = await derive(password, salt)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** A fresh bearer token: the prefix says what it opens, the rest is 32 random bytes. */
export function newToken(prefix: TokenPrefix): string {
  return `${prefix}_${randomBytes(TOKEN_BYTES).toString('base64url')}`
}

/** The digest a token is stored and looked up by. */
export function hashToken(pepper: string, token: string): string {
  return createHash('sha256')
    .update(pepper + token, 'utf8')
    .digest('hex')
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, SCRYPT_PARAMS, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}
