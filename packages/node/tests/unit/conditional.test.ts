import { mkdtemp, rm, readFile, readdir, mkdir, rename, writeFile, open } from 'node:fs/promises'
import { writeFileSync, existsSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { sha256 } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { conditionalFile } from '../../src/nodeConditional.js'

it.each(['move', 'write'] as const)(
  'rechecks the captured victim before %s publication',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'conditional-publication-writer-'))
    try {
      const fs = new NodeFileSystem(root)
      const original = new Uint8Array([1]),
        edited = new Uint8Array([2])
      await fs.writeAtomic('file.bin', original, 1000)
      const expected = { ...(await fs.stat('file.bin'))!, sha: await sha256(original) }
      const writer = await open(join(root, 'file.bin'), 'r+')
      try {
        let checks = 0
        const effect =
          kind === 'move' ? { kind, to: 'moved.bin' } : { kind, bytes: original, mtime: 1000 }
        expect(
          await conditionalFile(root, { path: 'file.bin', expected, effect }, () => {
            if (++checks === 5) writeSync(writer.fd, edited, 0, edited.length, 0)
          })
        ).toBe(false)
        expect(checks).toBe(6) // The refusal also checks authority before restoration.
        expect(await fs.read('file.bin')).toEqual(edited)
        expect(await fs.stat('moved.bin')).toBeNull()
      } finally {
        await writer.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('preserves bytes written through an open descriptor during removal authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conditional-open-writer-'))
  try {
    const fs = new NodeFileSystem(root)
    const original = new Uint8Array([1])
    const edited = new Uint8Array([2])
    await fs.writeAtomic('file.bin', original, 1000)
    const expected = {
      ...(await fs.stat('file.bin'))!,
      sha: await sha256(original),
      identity: (await fs.fileIdentity('file.bin'))!,
    }
    const writer = await open(join(root, 'file.bin'), 'r+')
    try {
      expect(
        await fs.conditionalFile({
          path: 'file.bin',
          expected,
          effect: { kind: 'remove' },
          authorize: async () => {
            await writer.write(edited, 0, edited.length, 0)
            await writer.utimes(1, 1)
            return true
          },
        })
      ).toBe(false)
      expect(await fs.read('file.bin')).toEqual(edited)
      await fs.recoverConditionalFiles()
      expect(await fs.read('file.bin')).toEqual(edited)
    } finally {
      await writer.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['deny', 'throw', 'occupant'] as const)(
  'preserves the captured removal victim when ownership check returns %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'conditional-owner-'))
    try {
      const fs = new NodeFileSystem(root)
      const bytes = new Uint8Array([1])
      await fs.writeAtomic('file.bin', bytes, 1000)
      const expected = {
        ...(await fs.stat('file.bin'))!,
        sha: await sha256(bytes),
        identity: (await fs.fileIdentity('file.bin'))!,
      }
      let calls = 0
      const result = fs.conditionalFile({
        path: 'file.bin',
        expected,
        effect: { kind: 'remove' },
        authorize: async () => {
          calls++
          expect(await fs.stat('file.bin')).toBeNull()
          if (mode === 'occupant') await fs.writeAtomic('file.bin', bytes, 1000)
          if (mode === 'throw') throw new Error('ownership read failed')
          return false
        },
      })
      if (mode === 'throw') await expect(result).rejects.toThrow('ownership read failed')
      else expect(await result).toBe(false)
      expect(calls).toBe(1)
      expect(await fs.read('file.bin')).toEqual(bytes)
      const retained = join(root, '.abele-sync/retained-removals')
      const copies = await readdir(retained).catch((error) => {
        if (error.code === 'ENOENT') return [] as string[]
        throw error
      })
      expect(copies).toHaveLength(mode === 'occupant' ? 1 : 0)
      for (const copy of copies)
        expect(new Uint8Array(await readFile(join(retained, copy, 'file.bin')))).toEqual(bytes)
      expect((await readdir(root)).filter((path) => path.includes('sync-conflict-'))).toEqual([])
      await fs.recoverConditionalFiles()
      expect(await fs.read('file.bin')).toEqual(bytes)
      expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('recovers an interrupted removal into private retention when its path has a new owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conditional-retained-removal-'))
  try {
    const directory = join(root, '.abele-sync/conditional/interrupted')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'intent.json'),
      JSON.stringify({ path: 'file.bin', effect: 'remove' })
    )
    await writeFile(join(directory, 'victim'), new Uint8Array([1]))
    await writeFile(join(root, 'file.bin'), new Uint8Array([2]))
    const fs = new NodeFileSystem(root)
    await fs.recoverConditionalFiles()
    await fs.recoverConditionalFiles()
    expect(await fs.read('file.bin')).toEqual(new Uint8Array([2]))
    expect(
      new Uint8Array(
        await readFile(join(root, '.abele-sync/retained-removals/interrupted/file.bin'))
      )
    ).toEqual(new Uint8Array([1]))
    const listed = []
    for await (const file of fs.list()) listed.push(file.path)
    expect(listed).toEqual(['file.bin'])
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
      expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
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
    await fs.discardInstallation('receipt')
    await expect(
      readFile(join(root, '.abele-sync/installations/receipt/data'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.read('file.bin')).toEqual(bytes)
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
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
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
      await expect(readFile(join(directory, 'victim'))).rejects.toMatchObject({ code: 'ENOENT' })
      if (saved)
        expect(await fs.read('file.bin.sync-conflict-interrupted')).toEqual(new Uint8Array([1]))
      expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
