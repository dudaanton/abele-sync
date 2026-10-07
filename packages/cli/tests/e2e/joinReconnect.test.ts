import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stateDbFile } from '../../src/vault.js'
import {
  cleanupFolders,
  cli,
  config,
  EMAIL,
  folder,
  PASSWORD,
  SETUP_MS,
} from './helpers/folders.js'
import { env, filledPair, initArgs } from './helpers/join.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * When `init` has nothing to ask: only one side holds files, or the folder's state says it is
 * the very vault it is set up on again. And when the state describes another vault, it goes.
 */

let server: SpawnedServer

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

describe('init with no question to ask', () => {
  it('asks nothing when only one side has files, or when the folder picks up where it left off', async () => {
    // An empty folder into a filled vault, and a filled folder into a new vault.
    const { laptop } = await filledPair(server, 'OneSide')
    const empty = await folder()
    expect((await cli(initArgs(server, empty, 'OneSide', 'empty'), env)).code).toBe(0)
    expect((await cli(initArgs(server, await folder(), 'Fresh vault', 'fresh'), env)).code).toBe(0)

    // Disconnected and set up again on the same vault: the state says it is the same vault.
    const gone = await cli(['disconnect', '--dir', laptop])
    expect(gone.code, gone.all).toBe(0)
    const back = await cli(initArgs(server, laptop, 'OneSide', 'laptop'), env)
    expect(back.code, back.all).toBe(0)
    expect(back.all).toContain('kept state.db: the same vault')
    expect(config(laptop).joinPrefer).toBeUndefined()
  })
  it('a folder disconnected from one vault and set up on another forgets the old state and asks', async () => {
    const { laptop } = await filledPair(server, 'Before')
    await filledPair(server, 'After')
    expect((await cli(['disconnect', '--dir', laptop])).code).toBe(0)
    expect(existsSync(stateDbFile(laptop))).toBe(true)
    const refused = await cli(initArgs(server, laptop, 'After', 'laptop'), env)
    expect(refused.code, refused.all).toBe(2)
    const run = await cli(initArgs(server, laptop, 'After', 'laptop', ['--prefer', 'server']), env)
    expect(run.code, run.all).toBe(0)
    expect(run.all).toContain('removed state.db: it described another vault')
  })
})
