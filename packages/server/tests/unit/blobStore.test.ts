import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BlobStore } from '../../src/blobs/store.js'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, createWriteStream: vi.fn(fs.createWriteStream) }
})

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe('BlobStore', () => {
  let store: BlobStore
  beforeEach(async () => {
    store = new BlobStore(await mkdtemp(join(tmpdir(), 'blobs-')), Buffer.alloc(32, 7))
  })

  it('stores by hash, dedups, and reads back', async () => {
    const bytes = Buffer.from('hello world')
    const a = await store.put(bytes)
    expect(a).toEqual({ sha: sha(bytes), size: 11, created: true })
    expect((await store.put(bytes)).created).toBe(false)
    expect(await store.has(a.sha)).toBe(true)
    expect((await store.get(a.sha)).toString()).toBe('hello world')
    expect((await store.getRange(a.sha, 6, 10)).toString()).toBe('world')
  })

  it('refuses a mismatching expected sha', async () => {
    await expect(store.put(Buffer.from('x'), 'a'.repeat(64))).rejects.toMatchObject({
      code: 'hash_mismatch',
    })
    expect(await store.has('a'.repeat(64))).toBe(false)
  })

  it('does not keep plaintext on disk', async () => {
    const { sha: s } = await store.put(Buffer.from('plaintext marker 12345'))
    const raw = await readFile(store.pathFor(s))
    expect(raw.subarray(0, 4).toString()).toBe('ABS1')
    expect(raw.includes(Buffer.from('plaintext marker'))).toBe(false)
  })

  it('cannot be read with another master key', async () => {
    const { sha: s } = await store.put(Buffer.from('secret'))
    const other = new BlobStore(store.dir, Buffer.alloc(32, 8))
    await expect(other.get(s)).rejects.toThrow()
  })

  it('returns not_found for an unknown sha and after delete', async () => {
    await expect(store.get('b'.repeat(64))).rejects.toMatchObject({ code: 'not_found' })
    const { sha: s } = await store.put(Buffer.from('bye'))
    await store.delete(s)
    expect(await store.has(s)).toBe(false)
  })

  it('stores an empty blob', async () => {
    const { sha: s, size } = await store.put(Buffer.alloc(0))
    expect(size).toBe(0)
    expect((await store.get(s)).length).toBe(0)
    expect(await store.intact(s)).toBe(true)
    expect((await store.put(Buffer.alloc(0))).created).toBe(false)
  })

  it('shards the path by the first two byte pairs of the sha', async () => {
    const { sha: s } = await store.put(Buffer.from('sharded'))
    expect(store.pathFor(s)).toBe(join(store.dir, s.slice(0, 2), s.slice(2, 4), s))
  })

  it('clamps a range to what the blob holds', async () => {
    const { sha: s } = await store.put(Buffer.from('0123456789'))
    expect((await store.getRange(s, 0, 99)).toString()).toBe('0123456789')
    expect((await store.getRange(s, 9, 9)).toString()).toBe('9')
    expect((await store.getRange(s, 20, 30)).length).toBe(0)
    expect((await store.getRange(s, 4, 2)).length).toBe(0)
    await expect(store.getRange('b'.repeat(64), 0, 1)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('streams a file in, checking its hash on the way', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blob-src-'))
    // Larger than one stream chunk, so the second pass really is a stream.
    const bytes = Buffer.alloc(200_000, 9)
    const src = join(dir, 'joined')
    await writeFile(src, bytes)

    const first = await store.putFile(src, sha(bytes))
    expect(first).toEqual({ sha: sha(bytes), size: bytes.length, created: true })
    expect((await store.putFile(src, sha(bytes))).created).toBe(false)
    expect(Buffer.compare(await store.get(sha(bytes)), bytes)).toBe(0)

    await expect(store.putFile(src, 'f'.repeat(64))).rejects.toMatchObject({
      code: 'hash_mismatch',
    })
    expect(await store.has('f'.repeat(64))).toBe(false)
  })

  it('does not report a store it cannot read as empty', async () => {
    // A regular file where the store's directory should be: stat says ENOTDIR, not ENOENT.
    const notADir = join(await mkdtemp(join(tmpdir(), 'blob-file-')), 'a-file')
    await writeFile(notADir, 'not a directory')
    const broken = new BlobStore(notADir, Buffer.alloc(32, 7))
    const failure = await broken.has('a'.repeat(64)).then(
      () => null,
      (error: NodeJS.ErrnoException) => error
    )
    // Which code the platform picks is its business; that it is not "nothing there" is the point.
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.code).not.toBe('ENOENT')
  })

  it('rejects, rather than taking the process down, when the shard will not be written', async () => {
    const bytes = Buffer.from('x'.repeat(100))
    const src = join(await mkdtemp(join(tmpdir(), 'blob-src-')), 'src')
    await writeFile(src, bytes)
    const shard = dirname(store.pathFor(sha(bytes)))
    await mkdir(shard, { recursive: true })
    const blocker = join(shard, 'not-a-directory')
    await writeFile(blocker, 'not a directory')
    // Fail a real write stream even as root, without failing the earlier intact/mkdir checks.
    const { createWriteStream } = await vi.importActual<typeof fs>('node:fs')
    const failingWrite = vi
      .spyOn(fs, 'createWriteStream')
      .mockImplementationOnce((_path, options) => createWriteStream(join(blocker, 'tmp'), options))
    try {
      // A stream error with nobody listening would end the test run instead of this call.
      await expect(store.putFile(src, sha(bytes))).rejects.toThrow()
      expect(failingWrite).toHaveBeenCalledOnce()
      expect(await store.has(sha(bytes))).toBe(false)
    } finally {
      failingWrite.mockRestore()
    }
  })

  it('refuses a file that is not there', async () => {
    await expect(store.putFile(join(store.dir, 'missing'), 'a'.repeat(64))).rejects.toThrow()
  })
})
