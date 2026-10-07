import { describe, expect, it } from 'vitest'
import { encodeText, sha256 } from '../../src/index.js'

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const HELLO = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'

describe('sha256', () => {
  it('hashes the empty input to the known digest', async () => {
    expect(await sha256(new Uint8Array())).toBe(EMPTY)
  })

  it('hashes "hello world" to the known digest', async () => {
    expect(await sha256(encodeText('hello world'))).toBe(HELLO)
  })

  it('returns lowercase hex of exactly 64 characters', async () => {
    const digest = await sha256(encodeText('Abele'))
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves zero bytes in place rather than trimming them', async () => {
    // A naive `toString(16)` per byte drops the leading zero of 0x0b; catch that.
    const digest = await sha256(new Uint8Array([0, 1, 2, 3]))
    expect(digest).toHaveLength(64)
    expect(digest).toBe(await sha256(new Uint8Array([0, 1, 2, 3])))
  })

  it('hashes a view of a larger buffer, not the whole buffer', async () => {
    const buffer = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer
    expect(await sha256(new Uint8Array(buffer, 2, 3))).toBe(await sha256(new Uint8Array([1, 2, 3])))
  })

  it('encodes text as UTF-8', () => {
    expect(Array.from(encodeText('é'))).toEqual([0xc3, 0xa9])
    expect(encodeText('')).toEqual(new Uint8Array())
  })
})
