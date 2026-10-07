import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError, selectiveDefaults } from '@abele/sync-core'
import { readConfig, writeConfig, type DaemonConfig } from '../../src/config.js'
import { openLog } from '../../src/log.js'

const POSIX_MODES = process.platform !== 'win32'

const config = (over: Partial<DaemonConfig> = {}): DaemonConfig => ({
  serverUrl: 'https://sync.example.test',
  vaultId: 'vault-1',
  deviceId: 'device-1',
  deviceToken: 'secret-token',
  deviceName: 'laptop',
  selective: selectiveDefaults(),
  ...over,
})

let dir: string
const stateDir = () => join(dir, '.abele-sync')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readConfig / writeConfig', () => {
  it('reads nothing from a vault that was never set up', () => {
    expect(readConfig(dir)).toBeNull()
  })

  it('round-trips a config, selective settings and all', () => {
    const cfg = config({ selective: { ...selectiveDefaults(), images: false, maxFileBytes: 42 } })
    writeConfig(dir, cfg)
    expect(readConfig(dir)).toEqual(cfg)
  })

  it('replaces a config that is already there', () => {
    writeConfig(dir, config())
    writeConfig(dir, config({ deviceName: 'desktop', deviceToken: 'newer' }))
    expect(readConfig(dir)).toMatchObject({ deviceName: 'desktop', deviceToken: 'newer' })
  })

  it.skipIf(!POSIX_MODES)('keeps the folder at 0700 and the file at 0600', async () => {
    writeConfig(dir, config())
    expect((await stat(stateDir())).mode & 0o777).toBe(0o700)
    expect((await stat(join(stateDir(), 'config.json'))).mode & 0o777).toBe(0o600)
  })

  it('leaves no temp file beside the config', async () => {
    writeConfig(dir, config())
    expect((await readdir(stateDir())).sort()).toEqual(['config.json'])
  })

  it('refuses a config that is not the shape the daemon needs', async () => {
    writeConfig(dir, config())
    await writeFile(join(stateDir(), 'config.json'), '{ not json')
    expect(() => readConfig(dir)).toThrow(EngineError)

    await writeFile(join(stateDir(), 'config.json'), JSON.stringify({ serverUrl: 'x' }))
    expect(() => readConfig(dir)).toThrowError(/deviceToken|vaultId|deviceId/)
  })

  it('fills in selective defaults a stored config predates', async () => {
    writeConfig(dir, config())
    const stored = JSON.parse(await readFile(join(stateDir(), 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >
    delete stored.selective
    await writeFile(join(stateDir(), 'config.json'), JSON.stringify(stored))
    expect(readConfig(dir)!.selective).toEqual(selectiveDefaults())
  })
})

describe('openLog', () => {
  it('appends timestamped lines to the vault log', async () => {
    const log = openLog(dir)
    log.line('daemon started')
    log.line('pushed 2 files')
    const lines = (await readFile(join(stateDir(), 'log'), 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z daemon started$/)
    expect(lines[1]).toMatch(/pushed 2 files$/)

    openLog(dir).line('a second opener appends')
    const after = (await readFile(join(stateDir(), 'log'), 'utf8')).trimEnd().split('\n')
    expect(after).toHaveLength(3)
  })
})
