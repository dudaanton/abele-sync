import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { encodeText, sha256 } from '@abele/sync-core'
import {
  clientFor,
  cleanupFolders,
  EMAIL,
  listing,
  manifestPaths,
  PASSWORD,
  read,
  SETUP_MS,
  syncOnce,
  vaultPair,
  write,
  type Pair,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * Hidden paths — any with a segment that starts with a dot, `.obsidian/` apart — are not the
 * vault's. A `.git` folder interleaved between two machines, or a `.DS_Store`, a Syncthing
 * marker, is damage, and Obsidian (so the plugin) never sees them at all. The daemon leaves
 * them where they are on both ends: not uploaded, not downloaded, and never deleted.
 */

let server: SpawnedServer
let pair: Pair

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
  pair = await vaultPair(server, 'Hidden')
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

describe('hidden paths', () => {
  it('are neither uploaded nor downloaded, while .obsidian settings are', async () => {
    const { a, b } = pair
    await write(a, '.git/HEAD', 'ref: refs/heads/main\n')
    await write(a, '.git/config', '[core]\n')
    await write(a, '.DS_Store', 'finder')
    await write(a, 'Sub/.DS_Store', 'finder')
    await write(a, 'Sub/note.md', 'visible\n')
    await write(a, '.obsidian/app.json', '{}')
    for (const dir of [a, b]) await syncOnce(dir)

    expect(await manifestPaths(a)).toEqual(['.obsidian/app.json', 'Sub/note.md'])
    expect(await listing(b)).toEqual(['.obsidian/app.json', 'Sub/note.md'])
    expect(await read(a, '.git/HEAD')).toBe('ref: refs/heads/main\n')
  })

  it('are never deleted on the server, nor fetched, when another client put them there', async () => {
    const { a, b } = pair
    await write(a, '.obsidian/app.json', '{}')
    await write(a, 'Sub/note.md', 'visible\n')
    await syncOnce(a)
    // A direct client cannot introduce a leading-dot path either; only .obsidian is reserved.
    const bytes = encodeText('marker')
    const sha = await sha256(bytes)
    const remote = clientFor(b)
    await remote.putBlob(sha, bytes)
    const refused = await remote.commit(
      [{ op: 'create', path: '.stfolder/marker', sha, size: bytes.length, mtime: 1000 }],
      'hidden-seed'
    )
    expect(refused.results[0]).toMatchObject({ status: 'rejected', code: 'invalid_path' })
    // Simulate a record left by an older release; the new API cannot create this path.
    const seeded = await remote.commit(
      [{ op: 'create', path: 'legacy-marker', sha, size: bytes.length, mtime: 1000 }],
      'legacy-seed'
    )
    expect(seeded.results[0]).toMatchObject({ status: 'applied' })
    const db = new Database(server.databasePath)
    try {
      db.prepare('update files set path = ?, path_ci = ? where path = ?').run(
        '.stfolder/marker',
        '.stfolder/marker',
        'legacy-marker'
      )
      db.prepare('update versions set path = ? where path = ?').run(
        '.stfolder/marker',
        'legacy-marker'
      )
    } finally {
      db.close()
    }
    await write(b, 'later.md', 'later\n')
    for (const dir of [a, b, a, b]) await syncOnce(dir)

    expect(await manifestPaths(a)).toEqual([
      '.obsidian/app.json',
      '.stfolder/marker',
      'Sub/note.md',
      'later.md',
    ])
    expect(await listing(a)).not.toContain('.stfolder/marker')
    expect(await listing(b)).not.toContain('.stfolder/marker')
  })
})
