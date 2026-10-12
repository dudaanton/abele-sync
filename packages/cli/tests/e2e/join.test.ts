import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupFolders, cli, config, read, SETUP_MS } from './helpers/folders.js'
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
describe('connect into a space that already holds files', () => {
  it('connects without a terminal and preserves both local bytes until the first run', async () => {
    const { joiner } = await filledPair(server, 'NoTerminal')
    const run = await cli(connectArgs(server, joiner, 'NoTerminal', 'joiner'))
    expect(run.code, run.all).toBe(0)
    expect(config(joiner).joinPrefer).toBeUndefined()
    expect(await read(joiner, 'Both.md')).toBe('joiner text\n')
  })
  it('refuses the removed --prefer and --force flags without replacing a connection', async () => {
    const { joiner } = await filledPair(server, 'Flags')
    const args = connectArgs(server, joiner, 'Flags', 'joiner')
    expect((await cli(args)).code).toBe(0)
    const before = config(joiner)
    for (const flags of [['--prefer', 'server'], ['--force']]) {
      expect((await cli([...args, ...flags])).code).toBe(2)
      expect(config(joiner)).toEqual(before)
      expect(await read(joiner, 'Both.md')).toBe('joiner text\n')
    }
  })
})
