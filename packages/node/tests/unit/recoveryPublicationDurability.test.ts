import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { sha256 } from '@abele/sync-core'
const model = vi.hoisted(() => ({ cut: false, dead: false, events: [] as string[] }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return Object.fromEntries(
    Object.entries(actual).map(([name, fn]) => [
      name,
      typeof fn !== 'function'
        ? fn
        : async (...args: unknown[]) => {
            if (model.dead) throw new Error('process crashed')
            if (['unlink', 'rm'].includes(name)) model.events.push(`retire:${String(args[0])}`)
            const value = await Reflect.apply(fn, actual, args)
            if (name === 'link' && model.cut) {
              model.dead = true
              throw new Error('process crashed immediately after link')
            }
            return value
          },
    ])
  )
})
vi.mock('../../src/nodeFsDurability.js', async (original) => {
  const actual = await original<typeof import('../../src/nodeFsDurability.js')>()
  return {
    ...actual,
    syncParents: async (files: string | readonly string[], root: string) => {
      await actual.syncParents(files, root)
      for (const path of typeof files === 'string' ? [files] : files)
        model.events.push(`durable:${path}`)
    },
  }
})
import { NodeFileSystem } from '../../src/nodeFs.js'

async function fixture(stageMode: boolean, receipt?: string) {
  const root = await mkdtemp(join(tmpdir(), 'publication-cut-')),
    fs = new NodeFileSystem(root)
  const old = new Uint8Array([1]),
    bytes = new Uint8Array([2]),
    sha = await sha256(bytes)
  await fs.writeAtomic('file', old, 1)
  const base = { ...(await fs.stat('file'))!, sha: await sha256(old) }
  const stage = stageMode ? await fs.beginAtomicWrite('file', 2, base) : undefined
  if (stage) {
    await stage.append(0, bytes)
    await stage.seal({ size: 1, sha })
  }
  model.cut = true
  try {
    await expect(
      stage
        ? stage.commit()
        : fs.conditionalFile({
            path: 'file',
            expected: base,
            effect: { kind: 'write', bytes, mtime: 2, receipt },
          })
    ).rejects.toThrow('process crashed')
    expect(model.dead).toBe(true)
  } finally {
    model.cut = false
    model.dead = false
  }
  model.events.length = 0
  return { root, fs, stage, sha }
}
const flushed = (root: string) => {
  const barrier = model.events.indexOf(`durable:${join(root, 'file')}`)
  expect(barrier, 'public destination must be durable').toBeGreaterThanOrEqual(0)
  for (const [at, event] of model.events.entries())
    if (event.startsWith('retire:')) expect(barrier, event).toBeLessThan(at)
}

it.each([false, true])(
  'D-069 recovery flushes publication before victim/evidence retirement (receipt %s)',
  async (receipt) => {
    const f = await fixture(false, receipt ? 'receipt' : undefined)
    try {
      await f.fs.recoverConditionalFiles()
      flushed(f.root)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  }
)

it('D-069 receipt adoption flushes a crash-installed public name before evidence discard', async () => {
  const f = await fixture(false, 'receipt')
  try {
    await f.fs.recoverConditionalFiles()
    model.events.length = 0
    expect(await f.fs.installedFile('receipt', 'file', f.sha)).toBe(true)
    await f.fs.discardInstallation('receipt')
    flushed(f.root)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

it('D-069 stage adoption flushes a crash-installed public name before evidence discard', async () => {
  const f = await fixture(true)
  try {
    expect(await f.stage!.installed!()).toBe(true)
    await f.stage!.discard()
    flushed(f.root)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
