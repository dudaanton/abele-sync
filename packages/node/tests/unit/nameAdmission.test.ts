import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { pathAdmission } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'

const host = vi.hoisted(() => ({ platform: 'win32', type: undefined as number | undefined }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => host.platform,
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    statfsSync: (...args: Parameters<typeof actual.statfsSync>) => {
      const value = actual.statfsSync(...args)
      return host.type === undefined ? value : { ...value, type: host.type }
    },
  }
})
const names = [
  'CON',
  'con.txt',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM9.txt',
  'LPT1',
  'LPT9.txt',
  'COM¹.txt',
  'LPT²',
  'CONIN$',
  'CONOUT$',
  'a:b',
  'a*b',
  'a?b',
  'a"b',
  'a<b',
  'a>b',
  'a|b',
  'tail.',
  'tail ',
  'parent./file.md',
]

it('admits names according to the actual host and gives Windows aliases the same key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-names-'))
  try {
    host.platform = 'win32'
    host.type = undefined
    const windows = new NodeFileSystem(root)
    for (const name of names)
      expect(windows[pathAdmission]?.(name), name).toEqual({
        allowed: false,
        reason: expect.stringContaining('unsupported-host-name:'),
      })
    expect(windows.pathKey('Folder. /Tail.md. ')).toBe(windows.pathKey('folder/tail.md'))
    for (const name of ['CON', 'a:b', 'tail.']) {
      await expect(windows.writeAtomic(name, new Uint8Array([1]), 1)).rejects.toMatchObject({
        code: 'invalid_path',
      })
      await expect(windows.mkdir(name)).rejects.toMatchObject({ code: 'invalid_path' })
      expect(await windows.stat(name)).toBeNull()
    }
    for (const name of ['CONtent.md', 'COM10.txt', 'LPT0', 'normal.md'])
      expect(windows[pathAdmission]?.(name)).toEqual({ allowed: true })
    for (const platform of ['linux', 'darwin']) {
      host.platform = platform
      const fs = new NodeFileSystem(root)
      for (const name of names)
        expect(fs[pathAdmission]?.(name), `${platform}: ${name}`).toEqual({ allowed: true })
      expect(fs.pathKey('tail.')).not.toBe(fs.pathKey('tail'))
    }
    host.platform = 'linux'
    host.type = 0x2011bab0
    const exfat = new NodeFileSystem(root)
    expect(exfat[pathAdmission]?.('a:b')).toMatchObject({ allowed: false })
    expect(exfat[pathAdmission]?.('CON')).toEqual({ allowed: true })
    expect(exfat.pathKey('tail. ')).toBe(exfat.pathKey('tail'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
