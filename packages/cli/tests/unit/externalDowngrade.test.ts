import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { selectiveDefaults } from '@abele/sync-core'
import * as Config from '../../src/config.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { readConfig as oldReadConfig } from '../fixtures/config-v1/config.js'
import { runInit as oldRunInit } from '../fixtures/config-v1/commands/init.js'
import { runInit } from '../../src/commands/init.js'

const cfg: Config.DaemonConfig = {
  serverUrl: 'https://synthetic.example.test',
  vaultId: 'vault',
  deviceId: 'device',
  deviceToken: 'absd_synthetic',
  deviceName: 'test',
  selective: selectiveDefaults(),
}
const descriptor = {
  ledgerId: 'ledger',
  instanceId: '12345678-1234-1234-1234-123456789abc',
  binding: {
    endpoint: cfg.serverUrl,
    vaultId: cfg.vaultId,
    mode: 'personal',
    principalId: cfg.deviceId,
    principalType: 'device',
    grantId: null,
    generation: 1,
    credentialAssociation: createHash('sha256').update(cfg.deviceToken).digest('hex'),
  },
}
async function scratch() {
  const root = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, 'downgrade-'))
}
describe('real pinned old-reader downgrade boundary', () => {
  it('BUG: new readers understand the versioned descriptor while the exact old readConfig rejects it', async () => {
    const dir = await scratch()
    try {
      Config.writeConfig(dir, cfg)
      expect(oldReadConfig(dir)).toEqual(cfg)
      writeFileSync(
        join(Config.stateFolder(dir), 'config.json'),
        JSON.stringify({ format: 'abele.cli', schema: 2, connection: cfg, descriptor })
      )
      expect(Config.readConfig(dir)).toEqual(cfg)
      expect(() => oldReadConfig(dir)).toThrowError(/no serverUrl/)
      // Ordinary writes (for example clearing join preference) must not downgrade the envelope.
      Config.writeConfig(dir, cfg)
      expect(() => oldReadConfig(dir)).toThrowError(/no serverUrl/)
      expect(
        JSON.parse(readFileSync(join(Config.stateFolder(dir), 'config.json'), 'utf8')).schema
      ).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('BUG: a schema field on an otherwise legacy config is not a downgrade fence', async () => {
    const dir = await scratch()
    try {
      Config.writeConfig(dir, cfg)
      writeFileSync(
        join(Config.stateFolder(dir), 'config.json'),
        JSON.stringify({ ...cfg, schema: 2 })
      )
      expect(oldReadConfig(dir)).toEqual(cfg)
      expect(() => Config.readConfig(dir)).toThrow() // New readers refuse ambiguous partial migration.
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('demonstrates that an old direct deletion can bypass config/database-open fences; surviving evidence is not permission to bootstrap', async () => {
    const dir = await scratch()
    try {
      Config.writeConfig(dir, cfg)
      const file = join(Config.stateFolder(dir), 'state.db'),
        db = SqliteStateStore.open(file)
      db.close()
      writeFileSync(
        join(Config.stateFolder(dir), 'config.json'),
        JSON.stringify({ format: 'abele.cli', schema: 2, connection: cfg, descriptor })
      )
      writeFileSync(
        join(Config.stateFolder(dir), 'external-activation.json'),
        JSON.stringify({ state: 'active', descriptor })
      )
      expect(() => oldReadConfig(dir)).toThrowError(/no serverUrl/)
      // Execute the pinned old force-init, whose fallback catches the config-open fence.
      const fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname
        const value =
          path === '/v1/auth/login'
            ? { account_token: 'abst_synthetic', expires_at: '2030-01-01T00:00:00.000Z' }
            : path === '/v1/devices'
              ? { device_id: 'replacement', device_token: 'absd_replacement' }
              : init?.method === 'GET'
                ? []
                : { id: 'foreign-vault' }
        return new Response(JSON.stringify(value))
      }
      const ctx = { fetch, env: {}, revokeTimeoutMs: 20, io: { out: () => {}, err: () => {} } }
      expect(
        await oldRunInit(
          {
            dir,
            server: cfg.serverUrl,
            email: 'synthetic@example.test',
            password: 'synthetic',
            force: true,
            prefer: 'merge',
          },
          ctx
        )
      ).toBe(0)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(join(Config.stateFolder(dir), 'external-activation.json'))).toBe(true)
      await expect(
        runInit(
          {
            dir,
            server: cfg.serverUrl,
            email: 'synthetic@example.test',
            password: 'synthetic',
            force: true,
          },
          ctx
        )
      ).rejects.toMatchObject({ reason: 'recovery-required' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
