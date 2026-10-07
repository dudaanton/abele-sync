import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stateFolder } from '../../src/config.js'
import {
  bytes,
  cleanupFolders,
  converge,
  EMAIL,
  listing,
  manifestPaths,
  PASSWORD,
  read,
  setSelective,
  SETUP_MS,
  syncOnce,
  vaultPair,
  write,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * What a folder chooses not to sync: a file type switched off in its config, and a pattern in
 * its `.abele-sync-ignore`. Neither leaves the folder, and the switched-off type is not fetched
 * either — until it is switched on again, when the daemon has to go back for what it passed over.
 */

let server: SpawnedServer
let a: string
let b: string

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
  const pair = await vaultPair(server, 'Selective')
  a = pair.a
  b = pair.b
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

describe('video switched off in A', () => {
  const clipA = randomBytes(512)
  const clipB = randomBytes(768)

  it("keeps A's clip local, and never fetches B's", async () => {
    setSelective(a, { video: false })
    await write(a, 'Clips/a.mp4', clipA)
    await write(a, 'note.md', 'text\n')
    await write(b, 'Clips/b.mp4', clipB)
    for (const dir of [a, b, a, b]) await syncOnce(dir)

    expect(await listing(a)).toEqual(['Clips/a.mp4', 'note.md'])
    expect(await listing(b)).toEqual(['Clips/b.mp4', 'note.md'])
    expect(await manifestPaths(a)).toEqual(['Clips/b.mp4', 'note.md'])
    expect(await read(b, 'note.md')).toBe('text\n')
  })

  it('brings both clips over once video is switched on again', async () => {
    setSelective(a, { video: true })
    // The feed has moved past B's clip; the daemon notices its settings changed and walks the
    // manifest again, then pushes A's clip as usual. B only has to follow the feed.
    await syncOnce(a)
    await syncOnce(b)

    expect(await listing(a)).toEqual(['Clips/a.mp4', 'Clips/b.mp4', 'note.md'])
    expect(await listing(b)).toEqual(['Clips/a.mp4', 'Clips/b.mp4', 'note.md'])
    expect(await bytes(a, 'Clips/b.mp4')).toEqual(clipB)
    expect(await bytes(b, 'Clips/a.mp4')).toEqual(clipA)
    expect(await readFile(join(stateFolder(a), 'log'), 'utf8')).toContain(
      'rescan: what this device syncs changed'
    )
    await converge(a, b)
  })
})

describe('.abele-sync-ignore', () => {
  it('keeps a pattern it names from ever being uploaded', async () => {
    await write(a, '.abele-sync-ignore', '*.tmp\n')
    await write(a, 'scratch.tmp', 'half a thought\n')
    await write(a, 'kept.md', 'kept\n')
    await syncOnce(a)
    await syncOnce(b)

    expect(await manifestPaths(a)).not.toContain('scratch.tmp')
    expect(await manifestPaths(a)).not.toContain('.abele-sync-ignore')
    expect(await listing(b)).not.toContain('scratch.tmp')
    expect(await read(b, 'kept.md')).toBe('kept\n')
    expect(await read(a, 'scratch.tmp')).toBe('half a thought\n')
  })

  it('lets a pattern dropped from it through, on the side that uploads and the side that fetches', async () => {
    // B keeps the pattern for now, so it passes over what A is about to upload.
    await write(b, '.abele-sync-ignore', '*.tmp\n')
    await write(a, '.abele-sync-ignore', '')
    await syncOnce(a)
    await syncOnce(a)
    expect(await manifestPaths(a)).toContain('scratch.tmp')
    await syncOnce(b)
    expect(await listing(b)).not.toContain('scratch.tmp')

    // B drops the pattern too: the feed has moved past the file, so B goes back for it.
    await rm(join(b, '.abele-sync-ignore'))
    await syncOnce(b)
    expect(await read(b, 'scratch.tmp')).toBe('half a thought\n')
    expect(await readFile(join(stateFolder(b), 'log'), 'utf8')).toContain(
      'rescan: what this device syncs changed'
    )
    await converge(a, b)
  })
})

describe('a folder skipped in A, emptied there, and taken back', () => {
  it('fetches the files again instead of deleting them everywhere', async () => {
    await write(a, 'Burst/x.md', 'x\n')
    await write(a, 'Burst/y.md', 'y\n')
    await converge(a, b)

    setSelective(a, { excludedFolders: ['Burst'] })
    await syncOnce(a)
    // Freeing space here: the files go from A's disk while A does not sync them.
    await rm(join(a, 'Burst'), { recursive: true })
    await syncOnce(a)
    expect(await manifestPaths(a)).toEqual(expect.arrayContaining(['Burst/x.md', 'Burst/y.md']))

    // Taken back by a fresh process, as the daemon is restarted with new settings.
    setSelective(a, { excludedFolders: [] })
    await syncOnce(a)
    await syncOnce(b)

    expect(await manifestPaths(a)).toEqual(expect.arrayContaining(['Burst/x.md', 'Burst/y.md']))
    expect(await read(a, 'Burst/x.md')).toBe('x\n')
    expect(await read(b, 'Burst/y.md')).toBe('y\n')
    await converge(a, b)
  })
})
