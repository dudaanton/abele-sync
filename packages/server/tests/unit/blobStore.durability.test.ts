import { createHash } from 'node:crypto'
import type { PathLike } from 'node:fs'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { BlobStore } from '../../src/blobs/store.js'

/**
 * A disk that gives out after the last byte: the write stream under `putFile`
 * takes everything, and then fails as it closes. Only while `armed`; every
 * other stream in the run, and every stream in every other file, is the real one.
 */
const late = vi.hoisted(() => ({ armed: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    createWriteStream: (path: PathLike, options?: Parameters<typeof fs.createWriteStream>[1]) => {
      const stream = fs.createWriteStream(path, options)
      if (late.armed) {
        stream.once('finish', () => stream.destroy(new Error('the disk gave out on close')))
      }
      return stream
    },
  }
})

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe('BlobStore durability', () => {
  it('rejects a putFile whose stream fails after the last byte, and leaves nothing at the shard', async () => {
    const store = new BlobStore(await mkdtemp(join(tmpdir(), 'blobs-')), Buffer.alloc(32, 7))
    const bytes = Buffer.alloc(100_000, 3)
    const src = join(await mkdtemp(join(tmpdir(), 'blob-src-')), 'joined')
    await writeFile(src, bytes)

    late.armed = true
    try {
      await expect(store.putFile(src, sha(bytes))).rejects.toThrow('gave out')
    } finally {
      late.armed = false
    }
    // Nothing was renamed into place, and the temp file did not outlive the failure.
    expect(await store.has(sha(bytes))).toBe(false)
    expect(await readdir(dirname(store.pathFor(sha(bytes))))).toEqual([])

    // With the disk behaving, the same file goes in whole.
    expect(await store.putFile(src, sha(bytes))).toEqual({
      sha: sha(bytes),
      size: bytes.length,
      created: true,
    })
    expect(Buffer.compare(await store.get(sha(bytes)), bytes)).toBe(0)
  })
})
