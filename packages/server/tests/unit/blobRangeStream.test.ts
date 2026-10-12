import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BlobStore } from '../../src/blobs/store.js'

it('streams only the requested plaintext without calling the whole-blob reader', async () => {
  const root = await mkdtemp(join(process.cwd(), '.blob-range-'))
  try {
    const store = new BlobStore(root, Buffer.alloc(32, 7))
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 3, 6)
    const { sha } = await store.put(bytes)
    store.get = async () => {
      throw new Error('whole blob read forbidden')
    }
    let length = 0
    for await (const chunk of store.streamRange(sha, 1024 * 1024, bytes.length - 1)) {
      expect(chunk.length).toBeLessThanOrEqual(1024 * 1024)
      expect(chunk.every((byte) => byte === 6)).toBe(true)
      length += chunk.length
    }
    expect(length).toBe(1024 * 1024 + 3)
    const corrupted = await readFile(store.pathFor(sha))
    corrupted[corrupted.length - 1]! ^= 1
    await writeFile(store.pathFor(sha), corrupted)
    let published = false
    await expect(
      (async () => {
        for await (const _chunk of store.streamRange(sha, 0, 2)) published = true
      })()
    ).rejects.toThrow()
    expect(published).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
