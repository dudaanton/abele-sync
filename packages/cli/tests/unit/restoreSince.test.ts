import { describe, expect, it } from 'vitest'
import { UsageError } from '../../src/context.js'
import { parseSince } from '../../src/commands/restoreSince.js'

describe('parseSince', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z')

  it('takes an amount of minutes, hours or days ago', () => {
    expect(new Date(parseSince('30m', now)).toISOString()).toBe('2026-09-27T11:30:00.000Z')
    expect(new Date(parseSince('2h', now)).toISOString()).toBe('2026-09-27T10:00:00.000Z')
    expect(new Date(parseSince('1d', now)).toISOString()).toBe('2026-09-26T12:00:00.000Z')
  })

  it('takes an ISO time, or a date as its UTC midnight', () => {
    expect(parseSince('2026-09-27T09:15:00Z', now)).toBe(Date.parse('2026-09-27T09:15:00Z'))
    expect(parseSince('2026-09-27', now)).toBe(Date.parse('2026-09-27T00:00:00Z'))
  })

  it('refuses anything else', () => {
    for (const raw of ['yesterday', '2 weeks', '1w', '', 'Sep 27']) {
      expect(() => parseSince(raw, now)).toThrow(UsageError)
    }
  })
})
