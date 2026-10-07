import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectiveDefaults } from '@abele/sync-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import { readConfig, writeConfig } from '../../src/config.js'
import { acquireLock } from '../../src/lock.js'
import type { CliIo } from '../../src/context.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * `init` writing over a config an earlier `init` left: the old device is revoked where that
 * can be done, and where it cannot the new setup still stands and says what is left over.
 *
 * A server of its own rather than `init.test.ts`'s: every `init` is a login, and the server
 * takes ten a minute from one address, which one file of them already comes close to.
 */

const EMAIL = 'replacing@example.com'
const PASSWORD = 'a-password-for-replacing'
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
  env: NodeJS.ProcessEnv = {},
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
  const code = await runCli(argv, env, io)
  return { code, out, err, all: [...out, ...err].join('\n') }
}

async function vaultDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'abele-vault-'))
  temps.push(dir)
  return dir
}

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

describe('the address init writes', () => {
  it('stores the address in one spelling, whatever was typed', async () => {
    const dir = await vaultDirectory()
    const typed = `${server.url.replace('http://', 'HTTP://')}/`
    const run = await cli([
      'init',
      '--server',
      typed,
      '--dir',
      dir,
      '--email',
      EMAIL,
      '--password',
      PASSWORD,
      '--vault',
      'OneSpelling',
    ])
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(readConfig(dir)?.serverUrl).toBe(server.url)
  })
})

describe('init --force over a device the server cannot be told about', () => {
  /** A config as an earlier `init` would have left it, on a server of the test's choosing. */
  async function leftBehind(serverUrl: string): Promise<string> {
    const dir = await vaultDirectory()
    writeConfig(dir, {
      serverUrl,
      vaultId: 'v-old',
      deviceId: 'd-old',
      deviceToken: 'absd_the-old-token',
      deviceName: 'old',
      selective: selectiveDefaults(),
    })
    return dir
  }

  const force = (dir: string, name: string, fetchImpl?: typeof fetch, extra?: Partial<CliIo>) =>
    cli(
      [
        'init',
        '--force',
        '--server',
        server.url,
        '--dir',
        dir,
        '--email',
        EMAIL,
        '--vault',
        name,
        '--password',
        PASSWORD,
      ],
      {},
      fetchImpl,
      extra
    )

  /** The real transport, counting what is sent to one host rather than to the test server. */
  const counting = (host: string): { fetch: typeof fetch; calls: () => number } => {
    let calls = 0
    return {
      fetch: (input, init) => {
        if (String(input instanceof Request ? input.url : input).startsWith(host)) calls++
        return fetch(input, init)
      },
      calls: () => calls,
    }
  }

  const leftover = 'the old device old (d-old) is still enrolled'

  it('sets up anyway when the old server is unreachable, and says what is left over', async () => {
    // Nothing listens on port 1: the revoke is refused at once.
    const dir = await leftBehind('http://127.0.0.1:1')
    const run = await force(dir, 'OldUnreachable')
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain(leftover)
    const cfg = readConfig(dir)!
    expect(cfg.serverUrl).toBe(server.url)
    expect(cfg.deviceId).not.toBe('d-old')
    const synced = await cli(['run', '--dir', dir, '--once'])
    expect(synced.err).toEqual([])
    expect(synced.code).toBe(0)
  })

  it('sends nothing to an old address the rule refuses, and says what is left over', async () => {
    const dir = await leftBehind('http://192.168.1.5:8787')
    const wire = counting('http://192.168.1.5')
    const run = await force(dir, 'OldRefused', wire.fetch)
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain(leftover)
    expect(wire.calls()).toBe(0)
    expect(readConfig(dir)?.serverUrl).toBe(server.url)
  })

  it('gives up on an old server that never answers, and still finishes', async () => {
    const dir = await leftBehind('http://127.0.0.2:8787')
    // Holds the revoke until its signal gives up on it; everything else goes through.
    const silent: typeof fetch = (input, init) => {
      if (!String(input).startsWith('http://127.0.0.2')) return fetch(input, init)
      return new Promise((_, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    }
    const run = await force(dir, 'OldSilent', silent, { revokeTimeoutMs: 200 })
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain(leftover)
  })

  it('leaves a vault alone while a daemon is syncing it', async () => {
    const dir = await leftBehind(server.url)
    const before = readConfig(dir)
    // This very process holds the lock, as a running daemon would.
    const release = await acquireLock(dir)
    let calls = 0
    const run = await force(dir, 'Busy', () => {
      calls++
      return Promise.reject(new Error('no request should have been made'))
    })
    expect(run.code).toBe(3)
    expect(run.err.join('\n')).toContain('stop it before setting up again')
    expect(calls).toBe(0)
    expect(readConfig(dir)).toEqual(before)
    release()
  })
})
