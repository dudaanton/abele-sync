import { expect, it } from 'vitest'
import { bytesFor } from '../../src/apply.js'
import { encodeText, MemoryFileSystem, sha256, type VaultClient } from '../../src/index.js'

it('hashes local bytes even when the stat before reading matched the ledger', async () => {
  const fs = new MemoryFileSystem()
  const original = encodeText('original'),
    changed = encodeText('changed!')
  const sha = await sha256(original)
  await fs.writeAtomic('Original.md', original, 1)
  const entry = {
    path: 'Original.md',
    wirePath: 'Original.md',
    fileId: 'f',
    versionId: 'v',
    sha,
    size: original.length,
    mtime: 1,
  }
  const read = fs.read.bind(fs)
  fs.read = async (path) => {
    await fs.writeAtomic(path, changed, 2)
    return read(path)
  }
  let fetched = 0
  const client = {
    getBlob: async () => {
      fetched++
      return original
    },
  } as unknown as VaultClient
  expect(await bytesFor(client, fs, sha, new Map([[sha, entry]]), sha256)).toEqual(original)
  expect(fetched).toBe(1)
})
