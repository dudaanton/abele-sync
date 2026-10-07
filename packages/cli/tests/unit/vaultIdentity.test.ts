import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { selectiveDefaults, SyncClient } from '@abele/sync-core'
import { writeConfig, readConfig } from '../../src/config.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { openVault, stateDbFile } from '../../src/vault.js'
import { runInit } from '../../src/commands/init.js'
import type { CommandContext } from '../../src/context.js'

vi.mock('../../src/join.js', () => ({ parsePrefer: () => null, joinPrefer: async () => null }))
const config = (vaultId: string) => ({
  serverUrl: 'http://localhost:8787',
  vaultId,
  deviceId: 'd',
  deviceToken: 't',
  deviceName: 'test',
  selective: selectiveDefaults(),
})
const context = {
  fetch,
  io: { out: () => {}, err: () => {} },
  env: {},
} as unknown as CommandContext

it('refuses state belonging to another vault before any metadata is overwritten', async () => {
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
      }).toThrow(/another vault/)
    } finally {
      opened?.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('resets foreign state before publishing the new config, even if init crashes immediately after', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-init-boundary-'))
  try {
    writeConfig(dir, config('A'))
    const state = SqliteStateStore.open(stateDbFile(dir))
    state.setMeta('vault', 'A')
    await state.setCursor(100)
    state.close()
    vi.spyOn(SyncClient, 'login').mockResolvedValue({ account_token: 'a' } as never)
    vi.spyOn(SyncClient.prototype, 'listVaults').mockResolvedValue([
      { id: 'B', name: 'B' },
    ] as never)
    vi.spyOn(SyncClient.prototype, 'enrolDevice').mockResolvedValue({
      device_id: 'new',
      device_token: 'new',
    } as never)
    const ctx = {
      ...context,
      io: {
        ...context.io,
        out: (line: string) => {
          if (line.startsWith('vault ')) throw new Error('crash boundary')
        },
      },
    }
    await expect(
      runInit(
        { dir, server: config('B').serverUrl, email: 'a', password: 'p', vault: 'B', force: true },
        ctx
      )
    ).rejects.toThrow('crash boundary')
    expect(readConfig(dir)?.vaultId).toBe('B')
    const after = SqliteStateStore.open(stateDbFile(dir))
    try {
      expect(await after.getCursor()).toBe(0)
      expect(after.getMeta('vault')).toBeNull()
    } finally {
      after.close()
    }
  } finally {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  }
})
