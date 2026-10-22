import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { openSync, closeSync, writeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { sha256 } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'

it.each(['remove', 'write', 'occupied'] as const)(
  'D-055 retains an open-descriptor edit after validation during %s',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'victim-'))
    let fd: number | undefined
    try {
      let armed = false,
        edited = false
      const fs = new NodeFileSystem(root, {
        effectGuard: () => {
          if (armed && !edited && !existsSync(join(root, 'file'))) {
            edited = true
            writeSync(fd!, new Uint8Array([3]), 0, 1, 0)
            if (kind === 'occupied') {
              const other = openSync(join(root, 'file'), 'wx')
              try {
                writeSync(other, new Uint8Array([4]))
              } finally {
                closeSync(other)
              }
            }
          }
        },
      })
      const original = new Uint8Array([1])
      await fs.writeAtomic('file', original, 1)
      const expected = { ...(await fs.stat('file'))!, sha: await sha256(original) }
      fd = openSync(join(root, 'file'), 'r+')
      armed = true
      const result = await fs.conditionalFile({
        path: 'file',
        expected,
        effect:
          kind === 'remove' ? { kind } : { kind: 'write', bytes: new Uint8Array([2]), mtime: 1 },
      })
      expect(edited).toBe(true)
      expect(result).toBe(false)
      const names = (await readdir(root)).filter(
        (name) => name === 'file' || name.startsWith('file.sync-conflict')
      )
      const bodies = await Promise.all(names.map((name) => readFile(join(root, name))))
      expect(bodies.some((body) => body.length === 1 && body[0] === 3)).toBe(true)
    } finally {
      if (fd !== undefined) closeSync(fd)
      await rm(root, { recursive: true, force: true })
    }
  }
)
