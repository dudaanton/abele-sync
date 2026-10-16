import { mkdtemp, rm, readFile, writeFile, mkdir, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { sha256 } from '@abele/sync-core'

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
    const directories = trace.slice(renamed + 1).filter((line) => line.startsWith('sync:'))
    expect(directories).toHaveLength(new Set(directories).size)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('syncs established stage ancestors only at creation and retains each metadata barrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abele-stage-durable-'))
  try {
    const fs = new NodeFileSystem(root)
    const bytes = new Uint8Array([1, 2, 3])
    trace.length = 0
    const stage = await fs.beginAtomicWrite('new/a.md', 1234, null)
    const folder = join(root, '.abele-sync/stages', stage.id)
    const syncs = () => trace.filter((line) => line.startsWith('sync:'))
    expect(syncs()).toEqual([
      `sync:${folder}/data`,
      `sync:${folder}/meta.next`,
      `sync:${folder}`,
      `sync:${root}/.abele-sync/stages`,
      `sync:${root}/.abele-sync`,
      `sync:${root}`,
    ])
    trace.length = 0
    await stage.append(0, bytes)
    expect(syncs()).toEqual([`sync:${folder}/data`, `sync:${folder}/meta.next`, `sync:${folder}`])
    // The creation checkpoint survives reopening; later metadata only changes the leaf.
    const reopened = await new NodeFileSystem(root).reopenStage(stage.id)
    trace.length = 0
    await reopened.seal({ size: bytes.length, sha: await sha256(bytes) })
    expect(syncs()).toEqual([`sync:${folder}/data`, `sync:${folder}/meta.next`, `sync:${folder}`])
    trace.length = 0
    await reopened.commit()
    expect(syncs()).toEqual([
      `sync:${folder}/meta.next`,
      `sync:${folder}`,
      `sync:${root}/new`,
      `sync:${root}`,
      `sync:${folder}/meta.next`,
      `sync:${folder}`,
    ])
    expect(await readFile(join(root, 'new/a.md'))).toEqual(Buffer.from(bytes))
    trace.length = 0
    await reopened.discard()
    expect(syncs()).toEqual([`sync:${root}/.abele-sync/stages`])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('flushes a recovered publication before recording its committed checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abele-published-durable-'))
  try {
    const fs = new NodeFileSystem(root)
    const bytes = new Uint8Array([1])
    const stage = await fs.beginAtomicWrite('new/a.md', 1234, null)
    await stage.append(0, bytes)
    await stage.seal({ size: 1, sha: await sha256(bytes) })
    const folder = join(root, '.abele-sync/stages', stage.id)
    const meta = JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8'))
    meta.phase = 'installing'
    await writeFile(join(folder, 'meta.json'), JSON.stringify(meta))
    await mkdir(join(root, 'new'))
    await link(join(folder, 'data'), join(root, 'new/a.md'))
    // Crash after publication, before its directory barrier and committed checkpoint.
    trace.length = 0
    await (await new NodeFileSystem(root).reopenStage(stage.id)).commit()
    expect(trace.filter((line) => line.startsWith('sync:'))).toEqual([
      `sync:${root}/new`,
      `sync:${root}`,
      `sync:${folder}/meta.next`,
      `sync:${folder}`,
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
