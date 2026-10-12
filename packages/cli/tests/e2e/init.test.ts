import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { encodeAccessToken } from '@abele/sync-protocol'
import { writeConfig, readConfig } from '../../src/config.js'
import { runCli } from '../../src/cli.js'
import { cleanupFolders, cli, folder, SETUP_MS } from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'
let server: SpawnedServer
beforeAll(async () => {
  server = await spawnServer()
}, SETUP_MS)
afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)
describe('token connection against a running server', () => {
  it('persists the token privately without printing it, and refuses a second connection', async () => {
    const dir = await folder(),
      token = server.tokenFor('Connected', 'laptop')
    const args = ['connect', '--dir', dir, '--token', token]
    const first = await cli(args)
    expect(first.code, first.all).toBe(0)
    expect(readConfig(dir)?.deviceToken).toBe(token)
    expect(first.all).not.toContain(token)
    const again = await cli(args)
    expect(again.code).toBe(2)
    expect(readConfig(dir)?.deviceToken).toBe(token)
  })
  it('takes the encoded token from ABELE_TOKEN without printing it', async () => {
    const dir = await folder(),
      token = server.tokenFor('Environment', 'laptop')
    const run = await cli(['connect', '--dir', dir], { ABELE_TOKEN: token })
    expect(run.code, run.all).toBe(0)
    expect(run.all).not.toContain(token)
    expect(readConfig(dir)?.deviceToken).toBe(token)
  })
})
describe('server address safety before any request', () => {
  it('rejects invalid token addresses without sending the secret', async () => {
    for (const address of [
      'http://192.168.1.5:8787',
      '192.168.1.5:8787',
      'http://evil.com@localhost:8787',
      'http://localhost\\@evil.com',
    ]) {
      const dir = await folder()
      // Encode raw JSON deliberately: the production encoder correctly rejects these addresses.
      const token = Buffer.from(
        JSON.stringify({
          v: 1,
          address,
          key: 'a'.repeat(43),
          scope: { kind: 'folder', id: 'root', path: '/' },
        })
      ).toString('base64')
      let calls = 0
      const code = await runCli(
        ['connect', '--dir', dir, '--token', token],
        {},
        {
          out() {},
          err() {},
          fetch: async () => {
            calls++
            throw new Error('must not send token')
          },
        }
      )
      expect(code).not.toBe(0)
      expect(calls).toBe(0)
      expect(readConfig(dir)).toBeNull()
    }
  })
  it('refuses unsafe stored addresses for run and status before network effects', async () => {
    const dir = await folder()
    writeConfig(dir, {
      serverUrl: 'http://192.168.1.5:8787',
      vaultId: 'space',
      deviceId: 'token',
      deviceToken: server.tokenFor('Safety', 'laptop'),
      deviceName: 'test',
      selective: selectiveDefaults(),
    })
    let calls = 0
    for (const command of [['run', '--once'], ['status']]) {
      const code = await runCli(
        [...command, '--dir', dir],
        {},
        {
          out() {},
          err() {},
          fetch: async () => {
            calls++
            throw new Error('must not send token')
          },
        }
      )
      expect(code).toBe(2)
    }
    expect(calls).toBe(0)
  })
  it('normalizes a token address to one spelling', async () => {
    const dir = await folder()
    const raw = JSON.parse(
      Buffer.from(server.tokenFor('Normalized', 'laptop'), 'base64').toString()
    )
    raw.address = `${server.url.replace('http://', 'HTTP://')}/`
    const token = encodeAccessToken(raw)
    const run = await cli(['connect', '--dir', dir, '--token', token])
    expect(run.code, run.all).toBe(0)
    expect(readConfig(dir)?.serverUrl).toBe(server.url)
  })
})
