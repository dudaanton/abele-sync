import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bytes,
  cleanupFolders,
  converge,
  EMAIL,
  listing,
  PASSWORD,
  read,
  setConflictMode,
  SETUP_MS,
  touch,
  vaultPair,
  write,
  type Pair,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * Two folders, one vault, and `run --once` in turn: what one folder does, the other comes to
 * hold. Every assertion is on files on disk. The scenarios build on one another the way a
 * vault's day does, so they run in this order.
 */

let server: SpawnedServer
let a: string
let b: string

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
  const pair: Pair = await vaultPair(server, 'Converge')
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

describe('two folders on one vault', () => {
  const image = randomBytes(2048)

  it('carries notes and an image made in A into B', async () => {
    await write(a, 'Notes/first.md', 'first\n')
    await write(a, 'second.md', 'second\n')
    await write(a, 'Attachments/pic.png', image)
    await converge(a, b)
    expect(await listing(b)).toEqual(['Attachments/pic.png', 'Notes/first.md', 'second.md'])
    expect(await read(b, 'Notes/first.md')).toBe('first\n')
    expect(await bytes(b, 'Attachments/pic.png')).toEqual(image)
  })

  it('renames in B what was renamed in A, with the same bytes and no second copy', async () => {
    await rename(join(a, 'second.md'), join(a, 'Notes/renamed.md'))
    await converge(a, b)
    expect(await listing(b)).toEqual(['Attachments/pic.png', 'Notes/first.md', 'Notes/renamed.md'])
    expect(await read(b, 'Notes/renamed.md')).toBe('second\n')
  })

  it('leaves no empty folder in B behind a folder renamed in A', async () => {
    await write(a, 'Burst/x.md', 'x\n')
    await write(a, 'Burst/y.md', 'y\n')
    await converge(a, b)
    await rename(join(a, 'Burst'), join(a, 'Renamed'))
    await converge(a, b)
    expect(await listing(b)).toContain('Renamed/x.md')
    expect(existsSync(join(b, 'Burst'))).toBe(false)
    await rm(join(a, 'Renamed'), { recursive: true })
    await converge(a, b)
    expect(existsSync(join(b, 'Renamed'))).toBe(false)
  })

  it('leaves no empty tree in B behind a nested folder renamed in A, and keeps an empty one B made', async () => {
    // The three-node report's B4: `Node/Deep/Deeper` renamed on one device left the empty old
    // tree behind on the others. A folder somebody made empty on this side is theirs.
    await write(a, 'Node/top.md', 'top\n')
    await write(a, 'Node/Deep/Deeper/z.md', 'z\n')
    await converge(a, b)
    await mkdir(join(b, 'Node/Deep/Mine'))
    await rename(join(a, 'Node/Deep'), join(a, 'Node/DeepRenamed'))
    await converge(a, b)
    expect(await read(b, 'Node/DeepRenamed/Deeper/z.md')).toBe('z\n')
    expect(existsSync(join(b, 'Node/Deep/Deeper'))).toBe(false)
    expect(existsSync(join(b, 'Node/Deep/Mine'))).toBe(true)

    await rm(join(a, 'Node/DeepRenamed'), { recursive: true })
    await converge(a, b)
    expect(existsSync(join(b, 'Node/DeepRenamed'))).toBe(false)
    expect(await read(b, 'Node/top.md')).toBe('top\n')
    await rm(join(b, 'Node'), { recursive: true })
    await converge(a, b)
  })

  it('deletes in B what was deleted in A', async () => {
    await rm(join(a, 'Notes/renamed.md'))
    await converge(a, b)
    expect(await listing(b)).toEqual(['Attachments/pic.png', 'Notes/first.md'])
  })

  it('merges disjoint edits made to one note in A and in B', async () => {
    await write(a, 'shared.md', 'one\ntwo\nthree\nfour\nfive\n')
    await converge(a, b)
    await write(a, 'shared.md', 'ONE\ntwo\nthree\nfour\nfive\n')
    await write(b, 'shared.md', 'one\ntwo\nthree\nfour\nFIVE\n')
    await converge(a, b)
    expect(await read(a, 'shared.md')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
    expect(await read(b, 'shared.md')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
  })

  it('in conflict-file mode, keeps the first committer and copies the second aside in both', async () => {
    await setConflictMode(a, 'conflict-file')
    const fromA = 'one\nTWO by laptop\nthree\nfour\nfive\n'
    const fromB = 'one\nTWO by phone\nthree\nfour\nfive\n'
    await write(a, 'shared.md', fromA)
    await write(b, 'shared.md', fromB)
    // A syncs first, so A's text is the head and B's is the copy — named after B's device.
    await converge(a, b)
    for (const dir of [a, b]) {
      expect(await read(dir, 'shared.md')).toBe(fromA)
      const copy = (await listing(dir)).find((path) =>
        /^shared \(Conflicted copy phone \d{12}\)\.md$/.test(path)
      )
      expect(copy).toBeDefined()
      expect(await read(dir, copy ?? '')).toBe(fromB)
    }
    expect(await listing(a)).toHaveLength(4)
  })

  it('gives an attachment edited in both to the newer mtime, in both', async () => {
    const older = randomBytes(64)
    const newer = randomBytes(96)
    await write(b, 'Attachments/pic.png', older)
    await touch(b, 'Attachments/pic.png', Date.now() - 60_000)
    await write(a, 'Attachments/pic.png', newer)
    await converge(a, b)
    expect(await bytes(a, 'Attachments/pic.png')).toEqual(newer)
    expect(await bytes(b, 'Attachments/pic.png')).toEqual(newer)
    // An attachment race makes no conflict copy: the four files from before, and no fifth.
    expect(await listing(a)).toHaveLength(4)
    expect(await listing(b)).toHaveLength(4)
  })
})
