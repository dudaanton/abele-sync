import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
 * `init --prefer` where there is nothing to decide: it is not taken
 * without a word. A server of its own, since every `init` here is a login the rate limit counts.
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

describe('init --prefer with nothing to decide', () => {
  it('says --prefer was not needed when there is nothing to decide, and keeps no choice', async () => {
    const prefer = ['--prefer', 'server']
    const { laptop } = await filledPair(server, 'NotNeeded')
    const empty = await folder()
    const oneSide = await cli(initArgs(server, empty, 'NotNeeded', 'empty', prefer), env)
    expect(oneSide.code, oneSide.all).toBe(0)
    expect(oneSide.all).toContain('--prefer not needed: this folder has no files to sync')
    expect(config(empty).joinPrefer).toBeUndefined()

    const fresh = await folder()
    const made = await cli(initArgs(server, fresh, 'Brand new', 'fresh', prefer), env)
    expect(made.code, made.all).toBe(0)
    expect(made.all).toContain('--prefer not needed: the vault is new')

    expect((await cli(['disconnect', '--dir', laptop])).code).toBe(0)
    const back = await cli(initArgs(server, laptop, 'NotNeeded', 'laptop', prefer), env)
    expect(back.code, back.all).toBe(0)
    expect(back.all).toContain('--prefer not needed: this folder picks up where it left off')
    expect(config(laptop).joinPrefer).toBeUndefined()
  })
})
