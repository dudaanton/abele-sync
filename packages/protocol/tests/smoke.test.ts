import { describe, it, expect } from 'vitest'
import { PROTOCOL_VERSION } from '../src/index.js'

describe('protocol package', () => {
  it('exports the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })
})
