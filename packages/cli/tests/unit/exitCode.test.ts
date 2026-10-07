import { expect, it } from 'vitest'
import { EXIT_REVOKED, processExitCode } from '../../src/context.js'

it('keeps a distinct CLI revoked status and maps only that status for the opt-in container runtime', () => {
  expect(EXIT_REVOKED).toBe(4)
  for (const code of [0, 1, 2, 3, 4, 137]) {
    expect(processExitCode(code, {})).toBe(code)
    expect(processExitCode(code, { ABELE_REVOKED_EXIT_ZERO: '0' })).toBe(code)
    expect(processExitCode(code, { ABELE_REVOKED_EXIT_ZERO: '1' })).toBe(code === 4 ? 0 : code)
  }
})
