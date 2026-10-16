import { expect, it } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, encodeText, scan, sha256 } from '../../src/index.js'

it('detects a same-stat rewrite within a bounded rolling sweep across restarts', async () => {
  const fs = new MemoryFileSystem()
  const state = new MemoryStateStore()
  for (let i = 0; i < 5; i++) {
    const path = `${i}.md`
    await fs.writeAtomic(path, encodeText('old'), 10)
    await state.put({
      path,
      wirePath: path,
      fileId: path,
      versionId: 'v1',
      sha: await sha256(encodeText('old')),
      size: 3,
      mtime: 10,
    })
  }
  await fs.writeAtomic('4.md', encodeText('new'), 10)
  let detected = false
  for (let pass = 0; pass < 5; pass++) {
    let reads = 0
    const found = await scan(
      fs,
      state,
      { excluded: () => false },
      {
        revalidate: 1,
        hash: async (bytes) => {
          reads++
          return sha256(bytes)
        },
      }
    )
    expect(reads).toBe(1)
    detected ||= found.ops.some((op) => op.op === 'modify' && op.file_id === '4.md')
  }
  expect(detected).toBe(true)
})

it('caps sweep work on a thousand-file vault and honors the byte budget without starving large files', async () => {
  const fs = new MemoryFileSystem()
  const state = new MemoryStateStore()
  const sha = await sha256(encodeText('old'))
  for (let i = 0; i < 1000; i++) {
    const path = `${String(i).padStart(4, '0')}.bin`
    await fs.writeAtomic(path, encodeText('old'), 10)
    await state.put({
      path,
      wirePath: path,
      fileId: path,
      versionId: 'v1',
      sha,
      size: 3,
      mtime: 10,
    })
  }
  let reads = 0
  const hash = async (bytes: Uint8Array) => {
    reads++
    return sha256(bytes)
  }
  await scan(fs, state, { excluded: () => false }, { revalidate: 16, hash })
  expect(reads).toBe(16)
  expect(await state.getMeta('content-sweep-after')).toBe('0015.bin')
  reads = 0
  await scan(fs, state, { excluded: () => false }, { revalidate: 16, revalidateBytes: 2, hash })
  expect(reads).toBe(1)
  expect(await state.getMeta('content-sweep-after')).toBe('0016.bin')
  reads = 0
  await scan(fs, state, { excluded: () => false }, { revalidate: 'all', hash, readOnly: true })
  expect(reads).toBe(1000)
  expect(await state.getMeta('content-sweep-after')).toBe('0016.bin')
})
