import { afterEach, expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({
  path: '',
  at: 0,
  calls: 0,
  directory: '',
  failure: new Error('probe unavailable'),
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === fault.path && ++fault.calls === fault.at) throw fault.failure
      return actual.lstat(...args)
    },
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]) === fault.directory) throw fault.failure
      return actual.readdir(...args)
    },
  }
})
import { mkdtemp, rm, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileSystem } from '../../src/nodeFs.js'
let dir = ''
afterEach(async () => {
  fault.path = fault.directory = ''
  fault.calls = 0
  if (dir) await rm(dir, { recursive: true, force: true })
})
it.each([2, 3])(
  'does not infer a free/different destination from stat failure at probe %s',
  async (at) => {
    dir = await mkdtemp(join(tmpdir(), 'abele-probe-'))
    const fs = new NodeFileSystem(dir)
    await fs.writeAtomic('old.bin', new Uint8Array([1]), 1)
    await link(join(dir, 'old.bin'), join(dir, 'OLD.BIN')).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
    fault.path = join(dir, 'OLD.BIN')
    fault.at = at
    await expect(fs.move('old.bin', 'OLD.BIN')).rejects.toBe(fault.failure)
  }
)
it('does not infer a failed respelling from unreadable directory entries', async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-probe-'))
  const fs = new NodeFileSystem(dir)
  await fs.writeAtomic('old.bin', new Uint8Array([1]), 1)
  await link(join(dir, 'old.bin'), join(dir, 'OLD.BIN')).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  fault.directory = dir
  await expect(fs.move('old.bin', 'OLD.BIN')).rejects.toMatchObject({ cause: fault.failure })
})
