import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStateStore, scan } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'

const fault = vi.hoisted(() => ({ path: '', code: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === fault.path)
        throw Object.assign(new Error('disk failure'), { code: fault.code })
      return actual.lstat(...args)
    },
  }
})
afterEach(() => {
  fault.path = ''
})
it.each(['EACCES', 'EIO'])('aborts a scan on %s rather than emitting a delete', async (code) => {
  const root = await mkdtemp(join(tmpdir(), 'abele-stat-'))
  try {
    await writeFile(join(root, 'a.md'), 'text')
    const fs = new NodeFileSystem(root),
      state = new MemoryStateStore()
    await state.put({
      path: 'a.md',
      wirePath: 'a.md',
      fileId: 'f',
      versionId: 'v',
      sha: 'a'.repeat(64),
      size: 4,
      mtime: 1,
    })
    fault.path = join(root, 'a.md')
    fault.code = code
    await expect(scan(fs, state, { excluded: () => false })).rejects.toMatchObject({ code: 'io' })
    await expect(fs.stat('a.md')).rejects.toMatchObject({ code: 'io' })
  } finally {
    fault.path = ''
    await rm(root, { recursive: true, force: true })
  }
})
