import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLAIN_HTTP_REFUSED } from '@abele/sync-protocol'
import { selectiveDefaults } from '@abele/sync-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import { readConfig, stateFolder, writeConfig } from '../../src/config.js'
import type { CliIo } from '../../src/context.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * The daemon against a real server: built, spawned, talked to over a socket.
 *
 * One server serves the whole file and one account owns everything in it; each test that
 * enrols does so into a vault of its own, named, so no test depends on which vaults the ones
 * before it left behind. The steps that share a vault directory run in the order they are
 * written — set up, push, look at, edit, delete, restore — because that is the sequence a
 * person actually puts a daemon through, and the fixture would be longer than the tests if
 * each one built the vault's history again.
 */

const EMAIL = 'daemon@example.com'
const PASSWORD = 'a-password-nobody-prints'
/** Building the server the first time is minutes; starting it is seconds. */
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
  fetchImpl?: typeof fetch
): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  }
  const code = await runCli(argv, env, io)
  return { code, out, err, all: [...out, ...err].join('\n') }
}

async function vaultDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'abele-vault-'))
  temps.push(dir)
  return dir
}

/** The vault as the server holds it, asked for with this device's own token. */
async function manifest(dir: string): Promise<Array<{ path: string; file_id: string }>> {
  const cfg = readConfig(dir)
  if (cfg === null) throw new Error(`${dir} has no config`)
  const response = await fetch(`${cfg.serverUrl}/v1/vaults/${cfg.vaultId}/manifest`, {
    headers: { authorization: `Bearer ${cfg.deviceToken}` },
  })
  if (!response.ok) throw new Error(`manifest answered ${response.status}`)
  const body = (await response.json()) as { items: Array<{ path: string; file_id: string }> }
  return body.items
}

const init = (dir: string, name: string, env: NodeJS.ProcessEnv = {}): Promise<Run> =>
  cli(
    [
      'init',
      '--server',
      server.url,
      '--dir',
      dir,
      '--email',
      EMAIL,
      '--vault',
      name,
      ...(env.ABELE_PASSWORD === undefined ? ['--password', PASSWORD] : []),
    ],
    env
  )

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

describe('init against a running server', () => {
  it('enrols a device and writes a config only this user can read', async () => {
    const dir = await vaultDirectory()
    const run = await init(dir, 'Enrolled')
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)

    const cfg = readConfig(dir)
    expect(cfg?.deviceToken).toMatch(/^absd_/)
    expect(cfg?.vaultId).not.toBe('')
    expect(cfg?.deviceName).not.toBe('')
    const mode = (await stat(join(stateFolder(dir), 'config.json'))).mode & 0o777
    expect(mode).toBe(0o600)
    expect(run.all).not.toContain(cfg?.deviceToken)
    expect(run.all).not.toContain(PASSWORD)
  })

  it('will not enrol a second time over a config it already wrote', async () => {
    const dir = await vaultDirectory()
    expect((await init(dir, 'Twice')).code).toBe(0)
    const token = readConfig(dir)?.deviceToken

    const again = await init(dir, 'Twice')
    expect(again.code).toBe(2)
    expect(again.err.join('\n')).toContain('already set up')
    // The token that was there is the token that is there: nothing was written over.
    expect(readConfig(dir)?.deviceToken).toBe(token)
  })

  it('takes the password from ABELE_PASSWORD and prints it nowhere', async () => {
    const dir = await vaultDirectory()
    const run = await init(dir, 'FromTheEnvironment', { ABELE_PASSWORD: PASSWORD })
    expect(run.code).toBe(0)
    expect(run.all).not.toContain(PASSWORD)
    expect(run.all).not.toContain(readConfig(dir)?.deviceToken)
  })
})

describe('the server address', () => {
  /** A transport that must never be used: the address is refused before any request. */
  const untouched = (): { fetch: typeof fetch; calls: () => number } => {
    let calls = 0
    return {
      fetch: () => {
        calls++
        return Promise.reject(new Error('no request should have been made'))
      },
      calls: () => calls,
    }
  }

  const initAt = (dir: string, url: string, fetchImpl?: typeof fetch): Promise<Run> =>
    cli(
      ['init', '--server', url, '--dir', dir, '--email', EMAIL, '--password', PASSWORD],
      {},
      fetchImpl
    )

  it('refuses plain http to another machine before the password is sent anywhere', async () => {
    const dir = await vaultDirectory()
    const wire = untouched()
    const run = await initAt(dir, 'http://192.168.1.5:8787', wire.fetch)
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain(PLAIN_HTTP_REFUSED)
    expect(wire.calls()).toBe(0)
    expect(readConfig(dir)).toBeNull()
  })

  it('asks for a scheme when the address has none', async () => {
    const dir = await vaultDirectory()
    const wire = untouched()
    const run = await initAt(dir, '192.168.1.5:8787', wire.fetch)
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('add https://')
    expect(wire.calls()).toBe(0)
  })

  it('refuses an address a stricter parser would read another host out of', async () => {
    for (const url of ['http://evil.com@localhost:8787', 'http://localhost\\@evil.com']) {
      const dir = await vaultDirectory()
      const wire = untouched()
      const run = await initAt(dir, url, wire.fetch)
      expect(run.code).toBe(2)
      expect(run.err.join('\n')).toContain('not a web address')
      expect(wire.calls()).toBe(0)
      expect(readConfig(dir)).toBeNull()
    }
  })

  it('refuses to run a config written for plain http to another machine', async () => {
    const dir = await vaultDirectory()
    writeConfig(dir, {
      serverUrl: 'http://192.168.1.5:8787',
      vaultId: 'v',
      deviceId: 'd',
      deviceToken: 'absd_not-to-be-sent',
      deviceName: 'old',
      selective: selectiveDefaults(),
    })
    const wire = untouched()
    const run = await cli(['run', '--dir', dir, '--once'], {}, wire.fetch)
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain(PLAIN_HTTP_REFUSED)
    expect(wire.calls()).toBe(0)
    // Nor does any other command send the token there.
    const status = await cli(['status', '--dir', dir], {}, wire.fetch)
    expect(status.code).toBe(2)
    expect(wire.calls()).toBe(0)
  })
})

describe('a device the server stops taking', () => {
  /** The account token, the way a person would get one: by logging in. */
  async function accountToken(): Promise<string> {
    const response = await fetch(`${server.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    if (!response.ok) throw new Error(`login answered ${response.status}`)
    return ((await response.json()) as { account_token: string }).account_token
  }

  it('is told what to do by run and status, and comes back with init --force', async () => {
    const dir = await vaultDirectory()
    await writeFile(join(dir, 'note.md'), 'before the revocation\n')
    expect((await init(dir, 'Revoked')).code).toBe(0)
    expect((await cli(['run', '--dir', dir, '--once'])).code).toBe(0)
    const before = readConfig(dir)!

    const token = await accountToken()
    const revoke = await fetch(`${server.url}/v1/devices/${before.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(revoke.ok).toBe(true)

    const run = await cli(['run', '--dir', dir, '--once'])
    expect(run.code).toBe(4)
    expect(run.err.join('\n')).toContain('init --force')
    const status = await cli(['status', '--dir', dir])
    expect(status.code).toBe(0)
    expect(status.err).toEqual([])
    expect(status.out.join('\n')).toMatch(/state\s+revoked/)
    expect(status.out.join('\n')).toContain('init --force')

    // Enrolled again into the same vault: a new device, a new token, the state kept.
    const again = await cli(
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
        'Revoked',
        '--password',
        PASSWORD,
      ],
      {}
    )
    expect(again.err).toEqual([])
    expect(again.code).toBe(0)
    expect(again.out.join('\n')).toContain('kept state.db')
    const after = readConfig(dir)!
    expect(after.vaultId).toBe(before.vaultId)
    expect(after.deviceId).not.toBe(before.deviceId)
    expect(after.deviceToken).not.toBe(before.deviceToken)
    expect(again.all).not.toContain(after.deviceToken)

    // And syncing works again, without a byte re-uploaded: the state still describes the vault.
    const synced = await cli(['run', '--dir', dir, '--once'])
    expect(synced.err).toEqual([])
    expect(synced.code).toBe(0)
    expect(synced.out.join('\n')).toContain('pushed 0')
    expect((await manifest(dir)).map((item) => item.path)).toEqual(['note.md'])
  })
})

describe('init --force over a device the server still takes', () => {
  it('revokes the device it replaces', async () => {
    const dir = await vaultDirectory()
    expect((await init(dir, 'Replaced')).code).toBe(0)
    const before = readConfig(dir)!

    const again = await cli([
      'init',
      '--force',
      '--server',
      server.url,
      '--dir',
      dir,
      '--email',
      EMAIL,
      '--vault',
      'Replaced',
      '--password',
      PASSWORD,
    ])
    expect(again.err).toEqual([])
    expect(again.code).toBe(0)
    expect(again.out.join('\n')).toContain(`revoked the old device (${before.deviceId})`)
    const after = readConfig(dir)!
    expect(after.deviceId).not.toBe(before.deviceId)

    const old = await fetch(`${server.url}/v1/vaults/${before.vaultId}/state`, {
      headers: { authorization: `Bearer ${before.deviceToken}` },
    })
    expect(old.status).toBe(401)
    expect((await manifest(dir)).length).toBe(0)
  })
})

describe('a vault through its life', () => {
  let dir: string

  beforeAll(async () => {
    dir = await vaultDirectory()
    await writeFile(join(dir, 'note.md'), 'one\ntwo\nthree\n')
    await writeFile(join(dir, 'keep.md'), 'kept\n')
    expect((await init(dir, 'Lifecycle')).code).toBe(0)
  }, SETUP_MS)

  it('uploads what the folder holds', async () => {
    const run = await cli(['run', '--dir', dir, '--once'])
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('sync: done')
    expect((await manifest(dir)).map((item) => item.path).sort()).toEqual(['keep.md', 'note.md'])
  })

  it('says where the vault stands', async () => {
    const run = await cli(['status', '--dir', dir])
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    const printed = run.out.join('\n')
    expect(printed).toContain('cursor')
    expect(printed).toContain('head_seq')
    expect(printed).toContain('pending    0')
    expect(printed).toContain('last error none')
    expect(printed).toMatch(/last sync +\d{4}-/)
    expect(printed).toMatch(/usage +live \d/)
  })

  it('diffs two versions of a note that was edited twice', async () => {
    await writeFile(join(dir, 'note.md'), 'one\ntwo and a half\nthree\n')
    expect((await cli(['run', '--dir', dir, '--once'])).code).toBe(0)
    await writeFile(join(dir, 'note.md'), 'one\ntwo and a half\nthree\nfour\n')
    expect((await cli(['run', '--dir', dir, '--once'])).code).toBe(0)

    const listed = await cli(['history', '--dir', dir, 'note.md'])
    expect(listed.code).toBe(0)
    expect(listed.out).toHaveLength(3)
    expect(listed.out[0]).toContain('#3')

    const diff = await cli(['history', '--dir', dir, 'note.md', '--diff', '1', '3'])
    expect(diff.err).toEqual([])
    expect(diff.code).toBe(0)
    const printed = diff.out.join('\n')
    expect(printed).toContain('@@')
    expect(printed).toContain('-two')
    expect(printed).toContain('+two and a half')
    expect(printed).toContain('+four')
  })

  it('brings a deleted note back', async () => {
    await rm(join(dir, 'keep.md'))
    expect((await cli(['run', '--dir', dir, '--once'])).code).toBe(0)
    expect((await manifest(dir)).map((item) => item.path)).not.toContain('keep.md')

    const run = await cli(['restore', '--dir', dir, '--deleted', 'keep.md'])
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('restored keep.md')
    expect(await readFile(join(dir, 'keep.md'), 'utf8')).toBe('kept\n')
    expect((await manifest(dir)).map((item) => item.path)).toContain('keep.md')
  })

  it('goes back to the version before the head', async () => {
    const run = await cli(['restore', '--dir', dir, 'note.md'])
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(await readFile(join(dir, 'note.md'), 'utf8')).toBe('one\ntwo and a half\nthree\n')
  })
})
