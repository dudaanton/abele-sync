import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
const events = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    unlink: async (path: string) => {
      events.push(`unlink:${path}`)
      return actual.unlink(path)
    },
  }
})
vi.mock('../../src/nodeFsDurability.js', async (original) => {
  const actual = await original<typeof import('../../src/nodeFsDurability.js')>()
  return {
    ...actual,
    syncParents: async (files: string | readonly string[], root: string) => {
      await actual.syncParents(files, root)
      for (const path of typeof files === 'string' ? [files] : files) events.push(`durable:${path}`)
    },
  }
})
import { restoreVictim } from '../../src/nodeConditional.js'

it('D-056 makes the restored destination durable before unlinking its backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-'))
  try {
    const folder = join(root, '.abele-sync/conditional/restore')
    await mkdir(folder, { recursive: true })
    const victim = join(folder, 'victim'),
      target = join(root, 'file')
    await writeFile(victim, new Uint8Array([3]))
    events.length = 0
    await restoreVictim(root, 'file', victim, 'restore')
    expect(events.indexOf(`durable:${target}`)).toBeGreaterThanOrEqual(0)
    expect(events.indexOf(`durable:${target}`)).toBeLessThan(events.indexOf(`unlink:${victim}`))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
