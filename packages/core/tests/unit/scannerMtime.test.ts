import { describe, expect, it } from 'vitest'
import { encodeText, MemoryFileSystem, MemoryStateStore, scan, sha256 } from '../../src/index.js'

describe('the scanner and a host clock before 1970', () => {
  it('dates a file with a negative mtime at the epoch, in the op and in what it read', async () => {
    const fs = new MemoryFileSystem()
    await fs.writeAtomic('old.md', encodeText('x'), -5)
    const found = await scan(fs, new MemoryStateStore(), { excluded: () => false })
    expect(found.ops).toEqual([
      { op: 'create', path: 'old.md', sha: await sha256(encodeText('x')), size: 1, mtime: 0 },
    ])
    expect(found.infos.get('old.md')).toMatchObject({ mtime: 0 })
  })
})
