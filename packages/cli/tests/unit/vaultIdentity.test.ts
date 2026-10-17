import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { writeConfig, readConfig } from '../../src/config.js'
import { SqliteStateStore } from '@abele/sync-node'
import { openVault, stateDbFile } from '../../src/vault.js'
import { runConnect } from '../../src/commands/connect.js'
import type { CommandContext } from '../../src/context.js'
import { tokenFor, connection } from '../helpers/token.js'
const config = (vaultId: string) => ({
  serverUrl: 'http://localhost:8787',
  vaultId,
  deviceId: 'd1',
  deviceToken: tokenFor('http://localhost:8787'),
  deviceName: 'test',
  selective: selectiveDefaults(),
})
const context = {
  fetch,
  io: { out() {}, err() {} },
  env: {},
  revokeTimeoutMs: 20,
} satisfies CommandContext
it('refuses state belonging to another space before any metadata is overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-identity-'))
  try {
    writeConfig(dir, config('B'))
    const state = SqliteStateStore.open(stateDbFile(dir))
    state.setMeta('vault', 'A')
    state.close()
    let opened: ReturnType<typeof openVault> | undefined
    try {
      expect(() => {
        opened = openVault(dir, context)
      }).toThrow(/another space/)
    } finally {
      opened?.close()
    }
    const after = SqliteStateStore.open(stateDbFile(dir))
    try {
      expect(after.getMeta('vault')).toBe('A')
    } finally {
      after.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('refuses connection to a foreign ledger instead of resetting its cursor or writing a config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-token-boundary-'))
  try {
    const state = SqliteStateStore.open(stateDbFile(dir))
    state.setMeta('vault', 'A')
    state.setMeta('token-connection', 'foreign')
    await state.setCursor(100)
    state.close()
    const before = readFileSync(stateDbFile(dir))
    await expect(
      runConnect(
        { dir, token: config('B').deviceToken },
        { ...context, fetch: async () => Response.json({ ...connection, space_id: 'B' }) }
      )
    ).rejects.toThrow(/another connection ledger/)
    expect(readConfig(dir)).toBeNull()
    expect(readFileSync(stateDbFile(dir))).toEqual(before)
    const after = SqliteStateStore.open(stateDbFile(dir))
    try {
      expect(await after.getCursor()).toBe(100)
      expect(after.getMeta('vault')).toBe('A')
    } finally {
      after.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
