import { describe, expect, it } from 'vitest'
import { CLI_NAME } from '../../src/cli.js'

describe('cli', () => {
  it('knows its own name', () => {
    expect(CLI_NAME).toBe('abele-sync')
  })
})
