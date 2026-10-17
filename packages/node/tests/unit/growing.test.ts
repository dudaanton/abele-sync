import { appendFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineError, type FileInfo } from '@abele/sync-core'
import { anyOf, SettlingFileSystem, type SettleableFileSystem } from '../../src/growing.js'
import { NodeFileSystem } from '../../src/nodeFs.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'abele-growing-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One listing, as the scanner would take it. */
async function list(fs: SettlingFileSystem): Promise<FileInfo[]> {
  const found: FileInfo[] = []
  for await (const info of fs.list()) found.push(info)
  return found
}

describe('a file that is still being written', () => {
  it('is passed over while it grows, and taken in once it stops', async () => {
    const file = join(root, 'video.mp4')
    await writeFile(file, 'x')
    const fs = new SettlingFileSystem(new NodeFileSystem(root))

    // Seen for the first time: nothing to compare it to, so nothing to wait for.
    expect(await list(fs)).toHaveLength(1)
    expect(fs.ignores('video.mp4')).toBe(false)

    // Bigger than the listing before saw it, and still going while it is looked at.
    appendFileSync(file, 'the copy is under way')
    const grow = setInterval(() => appendFileSync(file, 'more and more'), 25)
    try {
      await list(fs)
      expect(fs.ignores('video.mp4')).toBe(true)
    } finally {
      clearInterval(grow)
    }

    // It has stopped: the listing after that finds it settled and lets the scan have it.
    await list(fs)
    expect(fs.ignores('video.mp4')).toBe(false)
  })

  it('is still listed, so nothing takes it for a file that was deleted', async () => {
    const file = join(root, 'video.mp4')
    await writeFile(file, 'x')
    const fs = new SettlingFileSystem(new NodeFileSystem(root))
    await list(fs)

    // Bigger than the listing before saw it, and still going while it is looked at.
    appendFileSync(file, 'the copy is under way')
    const grow = setInterval(() => appendFileSync(file, 'more and more'), 25)
    try {
      const found = await list(fs)
      expect(found.map((info) => info.path)).toEqual(['video.mp4'])
      expect(fs.ignores('video.mp4')).toBe(true)
    } finally {
      clearInterval(grow)
    }
  })

  it('is forgotten once it is gone from the vault', async () => {
    const file = join(root, 'video.mp4')
    await writeFile(file, 'x')
    const fs = new SettlingFileSystem(new NodeFileSystem(root))
    await list(fs)

    // Bigger than the listing before saw it, and still going while it is looked at.
    appendFileSync(file, 'the copy is under way')
    const grow = setInterval(() => appendFileSync(file, 'more and more'), 25)
    try {
      await list(fs)
    } finally {
      clearInterval(grow)
    }
    expect(fs.ignores('video.mp4')).toBe(true)

    await rm(file)
    await list(fs)
    expect(fs.ignores('video.mp4')).toBe(false)
  })

  it('leaves a file whose size never moved alone', async () => {
    await writeFile(join(root, 'note.md'), 'steady')
    const fs = new SettlingFileSystem(new NodeFileSystem(root))
    await list(fs)
    const started = Date.now()
    await list(fs)
    // No `sizeStable` was asked for, so no pair of stats was waited on.
    expect(Date.now() - started).toBeLessThan(150)
    expect(fs.ignores('note.md')).toBe(false)
  })

  it('hands everything else straight to the disk', async () => {
    const fs = new SettlingFileSystem(new NodeFileSystem(root))
    await fs.writeAtomic('folder/note.md', new TextEncoder().encode('hi'), 1000)
    expect(await fs.stat('folder/note.md')).toEqual({
      path: 'folder/note.md',
      size: 2,
      mtime: 1000,
    })
    await fs.move('folder/note.md', 'moved.md')
    expect(new TextDecoder().decode(await fs.read('moved.md'))).toBe('hi')
    await fs.remove('moved.md')
    expect(await fs.stat('moved.md')).toBeNull()
  })
})

describe('several matchers', () => {
  it('ignore a path any one of them names', () => {
    const both = anyOf([{ ignores: (p) => p === 'a.md' }, { ignores: (p) => p.endsWith('.tmp') }])
    expect(both.ignores('a.md')).toBe(true)
    expect(both.ignores('b.tmp')).toBe(true)
    expect(both.ignores('b.md')).toBe(false)
  })
})

/**
 * A vault of files whose sizes the test moves by hand, and a `sizeStable` that takes as long as
 * a real one does. Nothing here touches a disk: what is being measured is how many of those
 * fifths of a second the wrapper spends one after another.
 */
class SlowDisk implements SettleableFileSystem {
  asked = 0
  readonly files = new Map<string, number>()

  constructor(
    count: number,
    private readonly stableMs: number,
    private readonly settled: boolean
  ) {
    for (let i = 0; i < count; i++) this.files.set(`file-${i}.md`, 100)
  }

  /** Every file grows by a byte, as a round of copying would leave them. */
  grow(): void {
    for (const [path, size] of this.files) this.files.set(path, size + 1)
  }

  async *list(): AsyncIterable<FileInfo> {
    for (const [path, size] of this.files) yield { path, size, mtime: 1 }
  }

  async sizeStable(path: string): Promise<boolean> {
    this.asked++
    await new Promise((resolve) => setTimeout(resolve, this.stableMs))
    return this.files.has(path) && this.settled
  }

  async stat(path: string): Promise<FileInfo | null> {
    const size = this.files.get(path)
    return size === undefined ? null : { path, size, mtime: 1 }
  }

  async read(): Promise<Uint8Array> {
    throw new EngineError('io', 'the fake disk holds no bytes')
  }
  async writeAtomic(): Promise<void> {
    throw new EngineError('io', 'the fake disk takes no writes')
  }
  async move(): Promise<void> {
    throw new EngineError('io', 'the fake disk moves nothing')
  }
  async remove(): Promise<void> {
    throw new EngineError('io', 'the fake disk removes nothing')
  }
}

describe('a listing where many files moved at once', () => {
  it('asks about them side by side rather than one after another', async () => {
    const disk = new SlowDisk(50, 20, false)
    const fs = new SettlingFileSystem(disk)
    await list(fs)
    expect(disk.asked).toBe(0)

    disk.grow()
    const started = Date.now()
    await list(fs)
    const took = Date.now() - started

    expect(disk.asked).toBe(50)
    // Fifty in a row would be a second; sixteen at a time is four waves of twenty milliseconds.
    expect(took).toBeLessThan(400)
    expect(fs.ignores('file-0.md')).toBe(true)
    expect(fs.ignores('file-49.md')).toBe(true)
  })

  it('asks about only so many in one round and leaves the rest for the next', async () => {
    const disk = new SlowDisk(100, 5, true)
    const fs = new SettlingFileSystem(disk)
    await list(fs)

    disk.grow()
    await list(fs)

    expect(disk.asked).toBe(64)
    const waiting = [...disk.files.keys()].filter((path) => fs.ignores(path))
    expect(waiting).toHaveLength(100 - 64)

    // The round after this one compares them against the size this listing recorded: they have
    // not moved since, so there is nothing left to ask about and the scan takes them in.
    await list(fs)
    expect(disk.asked).toBe(64)
    expect([...disk.files.keys()].filter((path) => fs.ignores(path))).toEqual([])

    // One that is still being written has moved again, and is asked about like any other.
    disk.grow()
    await list(fs)
    expect(disk.asked).toBe(64 + 64)
  })
})
