import { existsSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { readConfig, stateFolder, writeConfig } from '../../src/config.js'
import { acquireLock } from '@abele/sync-node'
import { runCli } from '../../src/cli.js'
import { AccessClient } from '@abele/sync-core'
import { cleanupFolders, cli, folder, SETUP_MS, write, read } from './helpers/folders.js'
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
async function connected(name: string) {
  const dir = await folder()
  await write(dir, 'note.md', `${name}\n`)
  expect(
    (await cli(['connect', '--dir', dir, '--token', server.tokenFor(name, 'laptop')])).code
  ).toBe(0)
  expect((await cli(['run', '--dir', dir, '--once'])).code).toBe(0)
  return dir
}
it('disconnects locally, retains the files and ledger, and does not revoke the shared token', async () => {
  const dir = await connected('Leaving'),
    cfg = readConfig(dir)!
  const run = await cli(['disconnect', '--dir', dir])
  expect(run.code, run.all).toBe(0)
  expect(run.all).toContain('token was not revoked')
  expect(run.all).not.toContain(cfg.deviceToken)
  expect(readConfig(dir)).toBeNull()
  expect(existsSync(`${stateFolder(dir)}/state.db`)).toBe(true)
  expect(await read(dir, 'note.md')).toBe('Leaving\n')
  expect((await AccessClient.fromToken(cfg.deviceToken, { fetch }).connection()).status).toBe(
    'active'
  )
  expect((await cli(['disconnect', '--dir', dir])).code).toBe(2)
  writeConfig(dir, cfg)
  expect((await cli(['disconnect', '--dir', dir])).code).toBe(0)
})
it('needs no network to disconnect an ordinary hydrated tree', async () => {
  const dir = await connected('Offline')
  let calls = 0
  const code = await runCli(
    ['disconnect', '--dir', dir],
    {},
    {
      out() {},
      err() {},
      fetch: async () => {
        calls++
        throw new Error('offline')
      },
    }
  )
  expect(code).toBe(0)
  expect(calls).toBe(0)
  expect(readConfig(dir)).toBeNull()
  expect(await read(dir, 'note.md')).toBe('Offline\n')
})
it('leaves a connection alone while a daemon is syncing it', async () => {
  const dir = await connected('Busy'),
    release = await acquireLock(dir)
  try {
    expect((await cli(['disconnect', '--dir', dir])).code).toBe(3)
    expect(readConfig(dir)).not.toBeNull()
  } finally {
    release()
  }
})
