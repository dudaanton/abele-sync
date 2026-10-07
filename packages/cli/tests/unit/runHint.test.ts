import { describe, expect, it } from 'vitest'
import { lostHint } from '../../src/commands/run.js'

/** What a daemon whose lock went says about starting again. */
describe('lostHint', () => {
  it('says a lapse was this machine sleeping, and how to start again', () => {
    const hint = lostHint('the lock could not be refreshed for 25 s', '/v')
    expect(hint).toMatch(/slept or stalled/)
    expect(hint).toContain('abele-sync run --dir /v')
    expect(hint).toMatch(/launchd|systemd/)
  })

  it('says to look for the other process after a takeover', () => {
    const hint = lostHint('the lock was taken over by pid 7 on nas', '/v')
    expect(hint).toMatch(/another abele-sync may be running/)
    expect(hint).not.toMatch(/slept/)
  })
})
