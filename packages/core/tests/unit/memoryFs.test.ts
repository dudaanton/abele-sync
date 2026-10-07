import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError, MemoryFileSystem, encodeText, type FileInfo } from '../../src/index.js'

const bytes = (s: string) => encodeText(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

async function collect(fs: MemoryFileSystem): Promise<FileInfo[]> {
  const found: FileInfo[] = []
  for await (const info of fs.list()) found.push(info)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

describe('MemoryFileSystem', () => {
  let fs: MemoryFileSystem

  beforeEach(() => {
    fs = new MemoryFileSystem()
  })

  it('reads back what writeAtomic wrote, with its size and mtime', async () => {
    await fs.writeAtomic('notes/a.md', bytes('hello'), 1000)
    expect(text(await fs.read('notes/a.md'))).toBe('hello')
    expect(await fs.stat('notes/a.md')).toEqual({ path: 'notes/a.md', size: 5, mtime: 1000 })
  })

  it('creates parent directories implicitly and lists regular files only', async () => {
    await fs.writeAtomic('deep/nested/dir/a.md', bytes('a'), 1)
    await fs.writeAtomic('b.md', bytes('bb'), 2)
    expect(await collect(fs)).toEqual([
      { path: 'b.md', size: 2, mtime: 2 },
      { path: 'deep/nested/dir/a.md', size: 1, mtime: 1 },
    ])
  })

  it('replaces the content and mtime of an existing path', async () => {
    await fs.writeAtomic('a.md', bytes('one'), 1)
    await fs.writeAtomic('a.md', bytes('second'), 2)
    expect(text(await fs.read('a.md'))).toBe('second')
    expect(await fs.stat('a.md')).toEqual({ path: 'a.md', size: 6, mtime: 2 })
    expect(await collect(fs)).toHaveLength(1)
  })

  it('throws an io EngineError when reading a missing path', async () => {
    await expect(fs.read('nope.md')).rejects.toThrow(EngineError)
    await expect(fs.read('nope.md')).rejects.toMatchObject({ code: 'io' })
  })

  it('stats a missing path as null', async () => {
    expect(await fs.stat('nope.md')).toBeNull()
  })

  it('moves a file, keeping its bytes and mtime', async () => {
    await fs.writeAtomic('from.md', bytes('body'), 7)
    await fs.move('from.md', 'sub/to.md')
    expect(await fs.stat('from.md')).toBeNull()
    expect(text(await fs.read('sub/to.md'))).toBe('body')
    expect(await fs.stat('sub/to.md')).toEqual({ path: 'sub/to.md', size: 4, mtime: 7 })
  })

  it('refuses to move onto an existing path and leaves both files alone', async () => {
    await fs.writeAtomic('from.md', bytes('from'), 1)
    await fs.writeAtomic('to.md', bytes('to'), 2)
    await expect(fs.move('from.md', 'to.md')).rejects.toMatchObject({ code: 'io' })
    expect(text(await fs.read('from.md'))).toBe('from')
    expect(text(await fs.read('to.md'))).toBe('to')
  })

  it('refuses to move a missing path', async () => {
    await expect(fs.move('missing.md', 'to.md')).rejects.toMatchObject({ code: 'io' })
  })

  it('removes a file, and removing a missing path is not an error', async () => {
    await fs.writeAtomic('a.md', bytes('a'), 1)
    await fs.remove('a.md')
    expect(await fs.stat('a.md')).toBeNull()
    await expect(fs.remove('a.md')).resolves.toBeUndefined()
    await expect(fs.remove('never/existed.md')).resolves.toBeUndefined()
  })

  it('hands out copies, so neither reads nor snapshots alias the store', async () => {
    const written = bytes('abc')
    await fs.writeAtomic('a.md', written, 1)
    written[0] = 0x7a
    expect(text(await fs.read('a.md'))).toBe('abc')

    const read = await fs.read('a.md')
    read[0] = 0x7a
    expect(text(await fs.read('a.md'))).toBe('abc')

    const snapshot = fs.snapshot()
    expect([...snapshot.keys()]).toEqual(['a.md'])
    expect(text(snapshot.get('a.md')!)).toBe('abc')
    snapshot.get('a.md')![0] = 0x7a
    snapshot.delete('a.md')
    expect(text(await fs.read('a.md'))).toBe('abc')
  })

  it('notifies watchers of emitted changes until they unsubscribe', async () => {
    const seen = vi.fn()
    const stop = fs.watch(seen)
    fs.emitChange(['a.md', 'b.md'])
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith(['a.md', 'b.md'])

    stop()
    fs.emitChange(['c.md'])
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('notifies every watcher, and stopping one leaves the others', () => {
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = fs.watch(first)
    fs.watch(second)
    fs.emitChange(['a.md'])
    stopFirst()
    stopFirst() // idempotent
    fs.emitChange(['b.md'])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})
