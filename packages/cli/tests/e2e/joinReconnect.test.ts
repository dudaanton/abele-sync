import { existsSync } from 'node:fs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { stateDbFile } from '../../src/vault.js'
import { cleanupFolders, cli, config, folder, read, SETUP_MS } from './helpers/folders.js'
import { filledPair, connectArgs } from './helpers/join.js'
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
it('connects empty folders and reconnects the same token with the ledger intact', async () => {
  const { laptop } = await filledPair(server, 'OneSide')
  expect((await cli(connectArgs(server, await folder(), 'OneSide', 'empty'))).code).toBe(0)
  expect((await cli(connectArgs(server, await folder(), 'Fresh space', 'fresh'))).code).toBe(0)
  expect((await cli(['disconnect', '--dir', laptop])).code).toBe(0)
  expect(existsSync(stateDbFile(laptop))).toBe(true)
  const back = await cli(connectArgs(server, laptop, 'OneSide', 'laptop'))
  expect(back.code, back.all).toBe(0)
  expect(config(laptop).joinPrefer).toBeUndefined()
})
it('refuses a different token without forgetting foreign state or files', async () => {
  const { laptop } = await filledPair(server, 'Before')
  await filledPair(server, 'After')
  expect((await cli(['disconnect', '--dir', laptop])).code).toBe(0)
  const ledger = stateDbFile(laptop)
  expect(existsSync(ledger)).toBe(true)
  const refused = await cli(connectArgs(server, laptop, 'After', 'laptop'))
  expect(refused.code, refused.all).toBe(2)
  expect(refused.all).toContain('another connection ledger')
  expect(existsSync(ledger)).toBe(true)
  expect(await read(laptop, 'Both.md')).toBe('laptop text\n')
})
