import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { writeConfig, readConfig, stateFolder } from '../../src/config.js'
import {
  activateExternalFiles,
  assertLocalSafety,
  ACTIVATION_FILE,
  SWITCH_FILE,
} from '../../src/externalSafety.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { acquireLock } from '../../src/lock.js'
import { readConfig as oldReadConfig } from '../fixtures/config-v1/config.js'

let dir: string
const cfg = {
  serverUrl: 'https://synthetic.example.test',
  vaultId: 'vault',
  deviceId: 'device',
  deviceToken: 'absd_synthetic',
  deviceName: 'test',
  selective: selectiveDefaults(),
}
const file = () => join(stateFolder(dir), 'state.db')
const marker = () =>
  JSON.parse(readFileSync(join(stateFolder(dir), ACTIVATION_FILE), 'utf8')) as {
    state: string
    descriptor: { ledgerId: string; instanceId: string }
  }
beforeEach(async () => {
  const root = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(root, { recursive: true })
  dir = await mkdtemp(join(root, 'activation-'))
  writeConfig(dir, cfg)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})
describe('recoverable CLI activation fence in the real ledger', () => {
  it('binds a versioned descriptor and marker to the actual reopened SQLite instance before activation', async () => {
    const lock = await acquireLock(dir)
    let raw = SqliteStateStore.open(file(), {
      effectGuard: () => {
        if (!lock.held()) throw new Error('lost')
      },
    })
    try {
      const descriptor = await activateExternalFiles(dir, raw, cfg, lock.held)
      expect(marker().state).toBe('active')
      expect(() => oldReadConfig(dir)).toThrowError(/no serverUrl/)
      expect(readConfig(dir)).toEqual(cfg)
      raw.close()
      raw = SqliteStateStore.open(file())
      expect(raw.getExternalInstanceId()).toBe(descriptor.instanceId)
      expect(JSON.parse((await raw.getExternalState())!).ledgerId).toBe(descriptor.ledgerId)
      expect(() => assertLocalSafety(dir)).toThrowError(
        expect.objectContaining({ reason: 'recovery-required' })
      )
    } finally {
      raw.close()
      lock()
    }
  })
  it('resumes a preparing marker after definite abort only in the same real ledger', async () => {
    const lock = await acquireLock(dir)
    let raw = SqliteStateStore.open(file())
    const driver = new SqliteDatabase(file())
    driver.exec(
      "CREATE TRIGGER reject_activation BEFORE INSERT ON meta WHEN NEW.key = 'daemon:external-files' BEGIN SELECT RAISE(ABORT, 'test abort'); END;"
    )
    driver.close()
    try {
      await expect(activateExternalFiles(dir, raw, cfg, lock.held)).rejects.toMatchObject({
        reason: 'aborted',
      })
      expect(marker().state).toBe('preparing')
      expect(() => oldReadConfig(dir)).toThrowError(/no serverUrl/)
      const original = marker().descriptor
      raw.close()
      raw = SqliteStateStore.open(file())
      const driver = new SqliteDatabase(file())
      driver.exec('DROP TRIGGER reject_activation')
      driver.close()
      expect(await activateExternalFiles(dir, raw, cfg, lock.held)).toMatchObject(original)
      expect(marker().state).toBe('active')
    } finally {
      raw.close()
      lock()
    }
  })
  it('an unknown initialization COMMIT never becomes active until reopen confirms the phase', async () => {
    const lock = await acquireLock(dir)
    let raw = SqliteStateStore.open(file()),
      exec = SqliteDatabase.prototype.exec
    try {
      vi.spyOn(SqliteDatabase.prototype, 'exec').mockImplementation(function (
        this: SqliteDatabase.Database,
        sql
      ) {
        const result = exec.call(this, sql)
        if (sql === 'COMMIT') throw new Error('lost acknowledgement')
        return result
      })
      await expect(activateExternalFiles(dir, raw, cfg, lock.held)).rejects.toMatchObject({
        reason: 'commit-unknown',
      })
      expect(marker().state).toBe('preparing')
      await expect(activateExternalFiles(dir, raw, cfg, lock.held)).rejects.toMatchObject({
        reason: 'recovery-required',
      })
      expect(marker().state).toBe('preparing')
      vi.restoreAllMocks()
      raw.close()
      raw = SqliteStateStore.open(file())
      await activateExternalFiles(dir, raw, cfg, lock.held)
      expect(marker().state).toBe('active')
    } finally {
      raw.close()
      lock()
    }
  })
  for (const phase of ['preparing', 'active'] as const)
    it(`BUG: resumed ${phase} activation refuses retained switch evidence before any effect`, async () => {
      const lock = await acquireLock(dir),
        raw = SqliteStateStore.open(file())
      try {
        await activateExternalFiles(dir, raw, cfg, lock.held)
        const activation = {
          ...marker(),
          format: 'abele.external.activation',
          schema: 1,
          ledgerFile: 'state.db',
          state: phase,
        }
        writeFileSync(join(stateFolder(dir), ACTIVATION_FILE), JSON.stringify(activation))
        writeFileSync(join(stateFolder(dir), SWITCH_FILE), '{unresolved switch')
        const before = readFileSync(join(stateFolder(dir), 'config.json')),
          document = await raw.getExternalState()
        await expect(activateExternalFiles(dir, raw, cfg, lock.held)).rejects.toMatchObject({
          reason: 'recovery-required',
        })
        expect(readFileSync(join(stateFolder(dir), 'config.json'))).toEqual(before)
        expect(await raw.getExternalState()).toBe(document)
        expect(marker().state).toBe(phase)
      } finally {
        raw.close()
        lock()
      }
    })
  it('BUG: an activation cannot attach a foreign database handle to this vault descriptor', async () => {
    const lock = await acquireLock(dir),
      other = SqliteStateStore.open(join(stateFolder(dir), 'foreign.db'))
    const before = readFileSync(join(stateFolder(dir), 'config.json'))
    try {
      await expect(activateExternalFiles(dir, other, cfg, lock.held)).rejects.toMatchObject({
        reason: 'recovery-required',
      })
      expect(existsSync(join(stateFolder(dir), ACTIVATION_FILE))).toBe(false)
      expect(readFileSync(join(stateFolder(dir), 'config.json'))).toEqual(before)
      expect(other.readExternalInstanceId()).toBeNull()
    } finally {
      other.close()
      lock()
    }
  })
  it('a replaced/missing activated ledger or active missing journal cannot receive an empty bootstrap', async () => {
    const lock = await acquireLock(dir)
    let raw = SqliteStateStore.open(file())
    try {
      await activateExternalFiles(dir, raw, cfg, lock.held)
      raw.setMeta('external-files', null)
      await expect(activateExternalFiles(dir, raw, cfg, lock.held)).rejects.toMatchObject({
        reason: 'recovery-required',
      })
      expect(await raw.getExternalState()).toBeNull()
      raw.close()
      for (const suffix of ['', '-wal', '-shm']) rmSync(file() + suffix, { force: true })
      raw = SqliteStateStore.open(file())
      await expect(activateExternalFiles(dir, raw, cfg, lock.held)).rejects.toMatchObject({
        reason: 'recovery-required',
      })
      expect(raw.readExternalInstanceId()).toBeNull()
      expect(await raw.getExternalState()).toBeNull()
      expect(existsSync(join(stateFolder(dir), ACTIVATION_FILE))).toBe(true)
    } finally {
      raw.close()
      lock()
    }
  })
})
