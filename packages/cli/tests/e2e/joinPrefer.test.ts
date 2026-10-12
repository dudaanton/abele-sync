import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  cleanupFolders,
  cli,
  config,
  listing,
  read,
  SETUP_MS,
  syncOnce,
  converge,
} from './helpers/folders.js'
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
it('token first-connect preserves server original and one local note conflict, then converges without more copies', async () => {
  const { laptop, joiner } = await filledPair(server, 'Merged')
  const run = await cli(connectArgs(server, joiner, 'Merged', 'joiner'))
  expect(run.code, run.all).toBe(0)
  expect(config(joiner).joinPrefer).toBeUndefined()
  await syncOnce(joiner)
  expect(await read(joiner, 'Both.md')).toBe('laptop text\n')
  const copies = (await listing(joiner)).filter((p) => p.startsWith('Both (Conflicted copy'))
  expect(copies).toHaveLength(1)
  expect(await read(joiner, copies[0]!)).toBe('joiner text\n')
  expect(await read(joiner, 'pic.png')).toBe('joiner image, newer')
  await converge(laptop, joiner)
  const before = await listing(joiner)
  await converge(laptop, joiner)
  expect(await listing(joiner)).toEqual(before)
  expect(before).toContain('Joiner only.md')
  expect(before).toContain('Laptop only.md')
})
