import { expect, it } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, scan } from '../../src/index.js'

it('prefers incremental host fingerprints to whole-file reads', async () => {
  const fs = new MemoryFileSystem()
  await fs.writeAtomic('large.bin', new Uint8Array(3), 7)
  Object.assign(fs, {
    fingerprint: async () => ({ size: 3, mtime: 7, generation: 'g', sha: 'a'.repeat(64) }),
    read: async () => {
      throw new Error('whole read forbidden')
    },
  })
  const result = await scan(fs, new MemoryStateStore(), { excluded: () => false })
  expect(result.ops).toEqual([
    { op: 'create', path: 'large.bin', sha: 'a'.repeat(64), size: 3, mtime: 7 },
  ])
})
