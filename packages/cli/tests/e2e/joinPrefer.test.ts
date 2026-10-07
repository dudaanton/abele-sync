import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bytes,
  cleanupFolders,
  cli,
  config,
  EMAIL,
  listing,
  PASSWORD,
  read,
  SETUP_MS,
  syncOnce,
} from './helpers/folders.js'
import { env, filledPair, historyShas, initArgs, serverText, sha } from './helpers/join.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * Each answer to the join question, carried through the first `run --once`: whichever side
 * wins, the other is in Version history, and the choice leaves the config once the join is done.
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

describe('init --prefer, and the first run after it', () => {
  it('--prefer server: the server is the head everywhere, and this folder’s copies are in history', async () => {
    const { laptop, joiner } = await filledPair(server, 'ServerWins')
    const run = await cli(
      initArgs(server, joiner, 'ServerWins', 'joiner', ['--prefer', 'server']),
      env
    )
    expect(run.code, run.all).toBe(0)
    expect(config(joiner).joinPrefer).toBe('theirs')
    const status = await cli(['status', '--dir', joiner])
    expect(status.all).toMatch(/^joining +the server wins where both hold a file/m)

    await syncOnce(joiner)
    expect(await read(joiner, 'Both.md')).toBe('laptop text\n')
    expect(await read(joiner, 'pic.png')).toBe('laptop image, older')
    expect(await historyShas(joiner, 'Both.md')).toContain(sha('joiner text\n'))
    expect(await historyShas(joiner, 'pic.png')).toContain(sha('joiner image, newer'))
    // What only this folder had still went up, and the disk now equals the server.
    await syncOnce(laptop)
    expect(await listing(joiner)).toEqual(await listing(laptop))
    for (const path of await listing(laptop)) {
      expect(await bytes(joiner, path)).toEqual(await bytes(laptop, path))
    }
    expect(await listing(joiner)).toContain('Joiner only.md')
    // The join is done, and the choice with it.
    expect(config(joiner).joinPrefer).toBeUndefined()
    expect((await cli(['status', '--dir', joiner])).all).not.toContain('joining')
  })
  it('--prefer local: this folder is the head everywhere, and the server’s copies are in history', async () => {
    const { laptop, joiner } = await filledPair(server, 'LocalWins')
    const run = await cli(
      initArgs(server, joiner, 'LocalWins', 'joiner', ['--prefer', 'local']),
      env
    )
    expect(run.code, run.all).toBe(0)
    expect(config(joiner).joinPrefer).toBe('mine')

    await syncOnce(joiner)
    expect(await serverText(joiner, 'Both.md')).toBe('joiner text\n')
    expect(await serverText(joiner, 'pic.png')).toBe('joiner image, newer')
    expect(await read(joiner, 'Both.md')).toBe('joiner text\n')
    expect(await historyShas(joiner, 'Both.md')).toContain(sha('laptop text\n'))
    expect(await historyShas(joiner, 'pic.png')).toContain(sha('laptop image, older'))
    expect(config(joiner).joinPrefer).toBeUndefined()
    await syncOnce(laptop)
    expect(await read(laptop, 'Both.md')).toBe('joiner text\n')
  })
  it('--prefer merge: both texts in the note, and nothing kept in the config', async () => {
    const { joiner } = await filledPair(server, 'Merged')
    const run = await cli(initArgs(server, joiner, 'Merged', 'joiner', ['--prefer', 'merge']), env)
    expect(run.code, run.all).toBe(0)
    expect(config(joiner).joinPrefer).toBeUndefined()
    await syncOnce(joiner)
    expect(await read(joiner, 'Both.md')).toBe('laptop text\njoiner text\n')
  })
})
