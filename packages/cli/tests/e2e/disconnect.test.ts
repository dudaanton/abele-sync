import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectiveDefaults } from '@abele/sync-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import { readConfig, stateFolder, writeConfig } from '../../src/config.js'
import { acquireLock } from '../../src/lock.js'
import type { CliIo } from '../../src/context.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * `abele-sync disconnect`: the device tells the server it is leaving, so its token stops
 * working, and the config that held the token goes. The state database stays, so setting the
 * same folder up again on the same vault has nothing to download twice.
 */

const EMAIL = 'leaving@example.com'
const PASSWORD = 'a-password-for-leaving'
const SETUP_MS = 10 * 60_000

let server: SpawnedServer
let temps: string[] = []

interface Run {
  code: number
  out: string[]
  err: string[]
  all: string
}

async function cli(
  argv: string[],
  fetchImpl?: typeof fetch,
  extra: Partial<CliIo> = {}
): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    ...extra,
  }
  const code = await runCli(argv, {}, io)
  return { code, out, err, all: [...out, ...err].join('\n') }
}

/** A folder set up on a vault of its own and synced once, so it has a state database. */
async function connected(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'abele-vault-'))
  temps.push(dir)
  await writeFile(join(dir, 'note.md'), `${name}\n`)
  const init = await cli([
    'init',
    '--server',
    server.url,
    '--dir',
    dir,
    '--email',
    EMAIL,
    '--password',
    PASSWORD,
    '--vault',
    name,
  ])
  expect(init.code).toBe(0)
  expect((await cli(['run', '--dir', dir, '--once'])).code).toBe(0)
  return dir
}

/** What the server answers this token on its own vault. */
async function stateStatus(serverUrl: string, vaultId: string, token: string): Promise<number> {
  const response = await fetch(`${serverUrl}/v1/vaults/${vaultId}/state`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return response.status
}

const unreachable: typeof fetch = () => Promise.reject(new TypeError('fetch failed'))

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    for (const dir of temps) await rm(dir, { recursive: true, force: true })
    temps = []
  }
}, SETUP_MS)

describe('disconnect', () => {
  it('revokes the device, removes the config and keeps the state', async () => {
    const dir = await connected('Leaving')
    const cfg = readConfig(dir)!

    const run = await cli(['disconnect', '--dir', dir])
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('revoked')
    expect(run.all).not.toContain(cfg.deviceToken)

    expect(await stateStatus(cfg.serverUrl, cfg.vaultId, cfg.deviceToken)).toBe(401)
    expect(readConfig(dir)).toBeNull()
    expect(existsSync(join(stateFolder(dir), 'state.db'))).toBe(true)

    // Not set up any more: nothing left to disconnect.
    expect((await cli(['disconnect', '--dir', dir])).code).toBe(2)
  })

  it('says so when the server had already let the device go, and still forgets it', async () => {
    const dir = await connected('Already')
    const cfg = readConfig(dir)!
    await cli(['disconnect', '--dir', dir])
    // Put the config back, as if a person had restored the folder from a backup.
    writeConfig(dir, cfg)

    const run = await cli(['disconnect', '--dir', dir])
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('already')
    expect(readConfig(dir)).toBeNull()
  })

  it('will not forget a device it could not tell the server about, unless forced', async () => {
    const dir = await connected('Offline')
    const cfg = readConfig(dir)!

    const refused = await cli(['disconnect', '--dir', dir], unreachable)
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('--force')
    expect(readConfig(dir)?.deviceToken).toBe(cfg.deviceToken)
    expect(await stateStatus(cfg.serverUrl, cfg.vaultId, cfg.deviceToken)).toBe(200)

    const forced = await cli(['disconnect', '--dir', dir, '--force'], unreachable)
    expect(forced.code).toBe(0)
    expect(forced.all).toContain(cfg.deviceId)
    expect(forced.all).not.toContain(cfg.deviceToken)
    expect(readConfig(dir)).toBeNull()
    expect(existsSync(join(stateFolder(dir), 'state.db'))).toBe(true)
    // The server was never told: the token still works until someone revokes it.
    expect(await stateStatus(cfg.serverUrl, cfg.vaultId, cfg.deviceToken)).toBe(200)
  })

  it('does not send the token to an address the rule refuses, and forgets it only when forced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'abele-vault-'))
    temps.push(dir)
    writeConfig(dir, {
      serverUrl: 'http://192.168.1.5:8787',
      vaultId: 'v',
      deviceId: 'd-lan',
      deviceToken: 'absd_not-to-be-sent',
      deviceName: 'lan',
      selective: selectiveDefaults(),
    })
    let calls = 0
    const untouched: typeof fetch = () => {
      calls++
      return Promise.reject(new Error('no request should have been made'))
    }

    const refused = await cli(['disconnect', '--dir', dir], untouched)
    expect(refused.code).toBe(1)
    expect(readConfig(dir)?.deviceToken).toBe('absd_not-to-be-sent')

    const forced = await cli(['disconnect', '--dir', dir, '--force'], untouched)
    expect(forced.code).toBe(0)
    expect(forced.all).toContain('d-lan')
    expect(readConfig(dir)).toBeNull()
    expect(calls).toBe(0)
  })

  it('gives up on a server that never answers, and lets go of the vault', async () => {
    const dir = await connected('Silent')
    const cfg = readConfig(dir)!
    const silent: typeof fetch = (_input, init) =>
      new Promise((_, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(signal.reason))
      })

    const run = await cli(['disconnect', '--dir', dir], silent, { revokeTimeoutMs: 200 })
    expect(run.code).toBe(1)
    expect(readConfig(dir)?.deviceToken).toBe(cfg.deviceToken)
    // The lock went with it: the next disconnect gets the vault.
    const after = await cli(['disconnect', '--dir', dir])
    expect(after.code).toBe(0)
  })

  it('leaves a vault alone while a daemon is syncing it', async () => {
    const dir = await connected('Busy')
    // This very process holds the lock, as a running daemon would.
    const release = await acquireLock(dir)
    const run = await cli(['disconnect', '--dir', dir])
    expect(run.code).toBe(3)
    expect(readConfig(dir)).not.toBeNull()
    release()
  })
})
