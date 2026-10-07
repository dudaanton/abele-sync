import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NodeFileSystem } from '../../src/nodeFs.js'

const trace = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        trace.push(`sync:${String(args[0])}`)
        await sync()
      }
      return handle
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      trace.push(`rename:${String(args[0])}:${String(args[1])}`)
      return fs.rename(...args)
    },
  }
})
it('syncs bytes before rename and every directory up to the vault before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abele-durable-'))
  try {
    const fs = new NodeFileSystem(root)
    trace.length = 0
    await fs.writeAtomic('new/nested/a.md', new TextEncoder().encode('durable'), 1234)
    const renamed = trace.findIndex((line) => line.startsWith('rename:'))
    expect(renamed).toBeGreaterThan(0)
    expect(trace[0]).toMatch(/sync:.*\/tmp\//)
    for (const dir of [
      root,
      join(root, 'new'),
      join(root, 'new/nested'),
      join(root, '.abele-sync/tmp'),
    ]) {
      expect(trace.indexOf(`sync:${dir}`)).toBeGreaterThan(renamed)
    }
    expect(await readFile(join(root, 'new/nested/a.md'), 'utf8')).toBe('durable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
