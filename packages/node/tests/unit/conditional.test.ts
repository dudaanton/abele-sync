import { mkdtemp, rm, readFile, readdir, mkdir, rename, writeFile } from 'node:fs/promises'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { sha256 } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'

it.each(['remove', 'move', 'write'] as const)(
  'quarantines and refuses a same-stat changed victim for %s',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'conditional-'))
    try {
      const fs = new NodeFileSystem(root),
        original = new Uint8Array([1]),
        edited = new Uint8Array([2])
      await fs.writeAtomic('file.bin', original, 1000)
      const expected = { ...(await fs.stat('file.bin'))!, sha: await sha256(original) }
      await fs.writeAtomic('file.bin', edited, 1000)
      const effect =
        kind === 'remove'
          ? { kind }
          : kind === 'move'
            ? { kind, to: 'other.bin' }
            : { kind, bytes: original, mtime: 1000 }
      expect(await fs.conditionalFile({ path: 'file.bin', expected, effect })).toBe(false)
      expect(new Uint8Array(await readFile(join(root, 'file.bin')))).toEqual(edited)
      expect(await fs.stat('other.bin')).toBeNull()
      expect(await readdir(join(root, '.abele-sync/conditional'))).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('installation receipts distinguish a publication from a later equal user save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conditional-'))
  try {
    const fs = new NodeFileSystem(root),
      bytes = new Uint8Array([1]),
      sha = await sha256(bytes)
    expect(
      await fs.conditionalFile({
        path: 'file.bin',
        expected: null,
        effect: { kind: 'write', bytes, mtime: 1000, receipt: 'receipt' },
      })
    ).toBe(true)
    expect(await fs.installedFile('receipt', 'file.bin', sha)).toBe(true)
    await fs.writeAtomic('file.bin', bytes, 1000)
    expect(await fs.installedFile('receipt', 'file.bin', sha)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retires a successful already-absent removal instead of revisiting it at every startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conditional-'))
  try {
    const fs = new NodeFileSystem(root)
    expect(
      await fs.conditionalFile({
        path: 'missing.bin',
        expected: { size: 1, mtime: 1, sha: await sha256(new Uint8Array([1])) },
        effect: { kind: 'remove' },
      })
    ).toBe(true)
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
    await fs.recoverConditionalFiles()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('exclusive publication preserves a save made while the victim is quarantined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conditional-'))
  try {
    let armed = false,
      injected = false
    const fs = new NodeFileSystem(root, {
      effectGuard: () => {
        if (armed && !injected && !existsSync(join(root, 'file.bin'))) {
          injected = true
          writeFileSync(join(root, 'file.bin'), new Uint8Array([3]))
        }
      },
    })
    const original = new Uint8Array([1])
    await fs.writeAtomic('file.bin', original, 1000)
    const expected = { ...(await fs.stat('file.bin'))!, sha: await sha256(original) }
    armed = true
    expect(
      await fs.conditionalFile({
        path: 'file.bin',
        expected,
        effect: { kind: 'write', bytes: new Uint8Array([2]), mtime: 1000 },
      })
    ).toBe(false)
    expect(injected).toBe(true)
    expect(await fs.read('file.bin')).toEqual(new Uint8Array([3]))
    const [id] = await readdir(join(root, '.abele-sync/conditional'))
    expect(
      new Uint8Array(await readFile(join(root, '.abele-sync/conditional', id!, 'victim')))
    ).toEqual(original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'recovers an interrupted capture without overwriting a later save (%s)',
  async (saved) => {
    const root = await mkdtemp(join(tmpdir(), 'conditional-'))
    try {
      const fs = new NodeFileSystem(root)
      await fs.writeAtomic('file.bin', new Uint8Array([1]), 1000)
      const directory = join(root, '.abele-sync/conditional/interrupted')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'intent.json'), JSON.stringify({ path: 'file.bin' }))
      await rename(join(root, 'file.bin'), join(directory, 'victim'))
      if (saved) await fs.writeAtomic('file.bin', new Uint8Array([3]), 1000)
      await new NodeFileSystem(root).recoverConditionalFiles()
      expect(await fs.read('file.bin')).toEqual(new Uint8Array([saved ? 3 : 1]))
      expect(new Uint8Array(await readFile(join(directory, 'victim')))).toEqual(new Uint8Array([1]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
