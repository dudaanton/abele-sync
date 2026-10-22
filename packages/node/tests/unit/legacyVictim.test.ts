import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { sha256 } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'

it.each([1, 3])(
  'D-057 validates legacy completed victims before retiring byte %i',
  async (value) => {
    const root = await mkdtemp(join(tmpdir(), 'victim-'))
    try {
      const folder = join(root, '.abele-sync/conditional-complete/legacy')
      await mkdir(folder, { recursive: true })
      const original = new Uint8Array([1])
      const fs = new NodeFileSystem(root)
      await fs.writeAtomic(
        '.abele-sync/conditional-complete/legacy/victim',
        new Uint8Array([value]),
        1
      )
      await writeFile(join(folder, 'complete'), '1')
      await writeFile(
        join(folder, 'intent.json'),
        JSON.stringify({
          path: 'file',
          effect: 'remove',
          expected: { size: 1, mtime: 1, sha: await sha256(original) },
        })
      )
      await fs.recoverConditionalFiles()
      if (value === 1) expect(await fs.stat('file')).toBeNull()
      else expect(await fs.read('file')).toEqual(new Uint8Array([3]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
