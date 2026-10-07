import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChangeItem } from '@abele/sync-protocol'
import { DEFERRED_KEY, selectiveDefaults } from '@abele/sync-core'
import { describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import { writeConfig } from '../../src/config.js'
import { codeArg, codeFingerprint, codeGroups, codePluginId } from '../../src/pluginCode.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { stateDbFile } from '../../src/vault.js'

const path = (id: string) => `.obsidian/plugins/${id}/main.js`
const change = (id: string, to: string, from: string | null = null): ChangeItem => ({
  file_id: id,
  version_id: `version-${id}`,
  path: to,
  prev_path: from,
  op: from === null ? 'create' : 'move',
  seq: 1,
  sha: 'a'.repeat(64),
  size: 1,
  mtime: 1,
  kind: 'settings',
  actor: { kind: 'device', id: 'remote', name: 'Remote device' },
  at: '2026-01-01T00:00:00.000Z',
})

describe('plugin code command boundaries', () => {
  it('classifies code at either spelling but not data, Abele or an unrelated folder', () => {
    expect(codePluginId(path('sample'))).toBe('sample')
    expect(codePluginId('.obsidian/plugins/sample/STYLES.CSS')).toBe('sample')
    expect(codePluginId('.obsidian/plugins/sample/nested/module.js')).toBe('sample')
    for (const file of [
      '.obsidian/plugins/sample/data.json',
      '.obsidian/plugins/sample/DATA.JSON',
      path('abele'),
      path('ABELE'),
      'plugins/sample/main.js',
      '.obsidian/community-plugins.json',
    ]) {
      expect(codePluginId(file)).toBeNull()
    }
  })

  it('groups every plugin connected by a move, independently of arrival order', () => {
    const changes = [
      change('one', path('beta'), path('alpha')),
      change('two', path('gamma'), path('beta')),
      change('three', path('separate')),
    ]
    const groups = codeGroups(changes)
    expect(groups.map((one) => one.ids)).toEqual([['alpha', 'beta', 'gamma'], ['separate']])
    expect(codeGroups([...changes].reverse()).map(codeFingerprint)).toEqual(
      groups.map(codeFingerprint)
    )
  })

  it('binds approval to versions, bytes, paths and the whole selected group', () => {
    const original = change('one', path('sample'))
    const fingerprint = (list: ChangeItem[]) => codeFingerprint(codeGroups(list)[0]!)
    const before = fingerprint([original])
    for (const patch of [
      { version_id: 'new-version' },
      { sha: 'b'.repeat(64) },
      { path: path('other') },
      { op: 'delete' as const, sha: null },
    ]) {
      expect(fingerprint([{ ...original, ...patch }])).not.toBe(before)
    }
    expect(fingerprint([original, change('two', '.obsidian/plugins/sample/styles.css')])).not.toBe(
      before
    )
  })

  it('quotes shell substitution and quotes in plugin ids without executing anything', () => {
    expect(codeArg('sample')).toBe('sample')
    expect(codeArg('$(sample)')).toBe("'$(sample)'")
    expect(codeArg("sample'plugin")).toBe("'sample'\\''plugin'")
  })

  it('shows locally held code in status even while the server is unreachable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'abele-code-status-'))
    try {
      writeConfig(dir, {
        serverUrl: 'https://sync.example.invalid',
        vaultId: 'vault',
        deviceId: 'device',
        deviceToken: 'absd_test',
        deviceName: 'Local device',
        selective: selectiveDefaults(),
      })
      const state = SqliteStateStore.open(stateDbFile(dir))
      state.setMeta(
        DEFERRED_KEY,
        JSON.stringify({ staged: [{ change: change('one', path('sample')), base: null }] })
      )
      state.close()
      const out: string[] = []
      const code = await runCli(
        ['status', '--dir', dir],
        {},
        {
          out: (line) => out.push(line),
          err: () => {},
          fetch: async () => {
            throw new Error('offline')
          },
        }
      )
      expect(code).toBe(1)
      expect(out.join('\n')).toContain('code awaiting approval')
      expect(out.join('\n')).toContain('sample')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
