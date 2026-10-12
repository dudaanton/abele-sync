import { describe, expect, it } from 'vitest'
import * as core from '@abele/sync-core'
import { runCli } from '../../src/cli.js'

describe('one token CLI surface', () => {
  it('has no legacy clients or scoped publication exports', () => {
    for (const name of [
      'SyncClient',
      'VaultClient',
      'createScopedClient',
      'ScopedState',
      'heldOwnerUnits',
      'PersonalNoteEvents',
    ])
      expect(core).not.toHaveProperty(name)
  })
  it('connects by one encoded token, not account/device/agent credentials', async () => {
    const out: string[] = []
    expect(
      await runCli(['connect', '--help'], {}, { out: (s) => out.push(s), err: (s) => out.push(s) })
    ).toBe(0)
    expect(out.join('\n')).toContain('--token')
    expect(out.join('\n')).not.toMatch(/--email|--password|--grant|--principal/)
    const help: string[] = []
    await runCli(['--help'], {}, { out: (s) => help.push(s), err: (s) => help.push(s) })
    expect(help.join('\n')).not.toMatch(/init|agent/)
  })
})
