import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupFolders,
  cli,
  clientFor,
  EMAIL,
  PASSWORD,
  read,
  SETUP_MS,
  syncOnce,
  vaultPair,
  write,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * `restore --deleted-since`: every file deleted since a moment, back
 * out of the trash through the bulk route, listed first with `--dry-run`. One vault pair for
 * the whole file: the server lets ten logins through a minute.
 */

let server: SpawnedServer
let a: string, b: string

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
  ;({ a, b } = await vaultPair(server, 'Since'))
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

const name = (k: number): string => `n${String(k).padStart(3, '0')}.md`

async function trashCount(dir: string): Promise<number> {
  return (await clientFor(dir).trash()).length
}

describe('restore --deleted-since', () => {
  it('lists with --dry-run, and restores without it', async () => {
    for (let k = 0; k < 5; k++) await write(a, name(k), `kept ${k}\n`)
    await syncOnce(a)
    for (let k = 0; k < 3; k++) await rm(join(a, name(k)))
    await syncOnce(a)
    expect(await trashCount(a)).toBe(3)

    const dry = await cli(['restore', '--dir', a, '--deleted-since', '1h', '--dry-run'])
    expect(dry.code).toBe(0)
    expect(dry.out[0]).toMatch(/^3 files in the trash were deleted since /)
    expect(dry.out.some((line) => line.includes(name(0)) && line.includes('by laptop'))).toBe(true)
    expect(await trashCount(a)).toBe(3)

    const done = await cli(['restore', '--dir', a, '--deleted-since', '1h'])
    expect(done.code).toBe(0)
    expect(done.out).toContain('restored 3; 0 came back under a new name; 0 failed')
    expect(await trashCount(a)).toBe(0)
    // Synced once under the lock, as a single restore is: the files are on this disk.
    expect(await read(a, name(0))).toBe('kept 0\n')
    await syncOnce(b)
    expect(await read(b, name(2))).toBe('kept 2\n')
  })

  it('finds nothing deleted since a moment in the future', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    const run = await cli(['restore', '--dir', a, '--deleted-since', future])
    expect(run.code).toBe(0)
    expect(run.out).toEqual([`nothing deleted since ${future} is in the trash`])
  })

  it('asks for --yes past 20 files when nobody is at a terminal', async () => {
    for (let k = 100; k < 121; k++) await write(a, name(k), `x ${k}\n`)
    await syncOnce(a)
    for (let k = 100; k < 121; k++) await rm(join(a, name(k)))
    // 21 of 26 is held by the guard; confirmed, the deletes reach the trash.
    await syncOnce(a)
    const listed = /--expect (\S+)/.exec((await cli(['deletes', '--dir', a])).all)?.[1] ?? ''
    expect((await cli(['deletes', '--dir', a, '--confirm', '--expect', listed])).code).toBe(0)
    await syncOnce(a)
    expect(await trashCount(a)).toBe(21)

    const asked = await cli(['restore', '--dir', a, '--deleted-since', '1d'])
    expect(asked.code).toBe(2)
    expect(asked.err.join('\n')).toMatch(/21 files; add --yes/)
    expect(await trashCount(a)).toBe(21)
    const done = await cli(['restore', '--dir', a, '--deleted-since', '1d', '--yes'])
    expect(done.code).toBe(0)
    expect(await trashCount(a)).toBe(0)
    expect(await read(a, name(120))).toBe('x 120\n')
  })

  it('refuses a moment it cannot read, and a file named beside it', async () => {
    expect((await cli(['restore', '--dir', a, '--deleted-since', 'yesterday'])).code).toBe(2)
    expect((await cli(['restore', 'x.md', '--dir', a, '--deleted-since', '1h'])).code).toBe(2)
    expect((await cli(['restore', 'x.md', '--dir', a, '--dry-run'])).code).toBe(2)
  })
})
