import { mkdtemp, rm, readdir, readFile, mkdir, writeFile, link, lstat } from 'node:fs/promises'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { sha256 } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'

it.each([1, 3])(
  'refuses a directory substituted at capture guard %i without hiding it',
  async (guard) => {
    const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
    try {
      let armed = false,
        calls = 0
      const fs = new NodeFileSystem(root, {
        effectGuard: () => {
          if (armed && ++calls === guard) {
            armed = false
            rmSync(join(root, 'file'))
            mkdirSync(join(root, 'file'))
            writeFileSync(join(root, 'file/local'), 'local')
          }
        },
      })
      const bytes = new Uint8Array([1])
      await fs.writeAtomic('file', bytes, 1)
      const expected = { ...(await fs.stat('file'))!, sha: await sha256(bytes) }
      armed = true
      expect(await fs.conditionalFile({ path: 'file', expected, effect: { kind: 'remove' } })).toBe(
        false
      )
      expect(await readFile(join(root, 'file/local'), 'utf8')).toBe('local')
      expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('retires a restored mismatch so recovery cannot undo a subsequent local deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
  try {
    const fs = new NodeFileSystem(root),
      original = new Uint8Array([1]),
      edited = new Uint8Array([2])
    await fs.writeAtomic('file', original, 1)
    const expected = { ...(await fs.stat('file'))!, sha: await sha256(original) }
    await fs.writeAtomic('file', edited, 1)
    expect(await fs.conditionalFile({ path: 'file', expected, effect: { kind: 'remove' } })).toBe(
      false
    )
    expect(await fs.read('file')).toEqual(edited)
    await fs.remove('file')
    await fs.recoverConditionalFiles()
    expect(await fs.stat('file')).toBeNull()
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('drops a verified victim immediately after successful publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
  try {
    const fs = new NodeFileSystem(root),
      original = new Uint8Array([1])
    await fs.writeAtomic('file', original, 1)
    expect(
      await fs.conditionalFile({
        path: 'file',
        expected: { ...(await fs.stat('file'))!, sha: await sha256(original) },
        effect: { kind: 'write', bytes: new Uint8Array([2]), mtime: 1, receipt: 'receipt' },
      })
    ).toBe(true)
    await expect(
      readFile(join(root, '.abele-sync/conditional-complete/receipt/victim'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(root, '.abele-sync/installations/receipt/victim'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('recovers a directory captured by an older primitive and retires that record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
  try {
    const folder = join(root, '.abele-sync/conditional/legacy')
    await mkdir(join(folder, 'victim'), { recursive: true })
    await writeFile(join(folder, 'victim/local'), 'local')
    await writeFile(join(folder, 'intent.json'), JSON.stringify({ path: 'folder' }))
    await new NodeFileSystem(root).recoverConditionalFiles()
    expect(await readFile(join(root, 'folder/local'), 'utf8')).toBe('local')
    await rm(join(root, 'folder'), { recursive: true })
    await new NodeFileSystem(root).recoverConditionalFiles()
    await expect(readFile(join(root, 'folder/local'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retries an already-linked conflict restoration without losing the occupant or victim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
  try {
    const folder = join(root, '.abele-sync/conditional/conflicted')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'victim'), new Uint8Array([3]))
    await writeFile(join(folder, 'intent.json'), JSON.stringify({ path: 'file' }))
    await writeFile(join(folder, 'restoring'), '1')
    await writeFile(join(root, 'file'), new Uint8Array([4]))
    // Exact durable image after conflict link succeeds, before its victim unlink.
    await link(join(folder, 'victim'), join(root, 'file.sync-conflict-conflicted'))
    const fs = new NodeFileSystem(root)
    await fs.recoverConditionalFiles()
    expect(new Uint8Array(await readFile(join(root, 'file')))).toEqual(new Uint8Array([4]))
    expect(new Uint8Array(await readFile(join(root, 'file.sync-conflict-conflicted')))).toEqual(
      new Uint8Array([3])
    )
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
    await fs.recoverConditionalFiles()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retries the absent original name when only restoration intent is known', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
  try {
    const folder = join(root, '.abele-sync/conditional/restoring')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'victim'), new Uint8Array([3]))
    await writeFile(join(folder, 'intent.json'), JSON.stringify({ path: 'file' }))
    await writeFile(join(folder, 'restoring'), '1')
    await new NodeFileSystem(root).recoverConditionalFiles()
    // D-075: intent alone cannot distinguish a deletion from a link never installed.
    expect(new Uint8Array(await readFile(join(root, 'file')))).toEqual(new Uint8Array([3]))
    await expect(readFile(join(root, 'file.sync-conflict-restoring'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retires a verified victim after an interrupted publication without making a conflict or losing its receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
  try {
    const fs = new NodeFileSystem(root),
      old = new Uint8Array([1]),
      bytes = new Uint8Array([2])
    await fs.writeAtomic('file', old, 1)
    const expected = { ...(await fs.stat('file'))!, sha: await sha256(old) }
    const folder = join(root, '.abele-sync/conditional/published')
    await mkdir(folder, { recursive: true })
    await fs.move('file', '.abele-sync/conditional/published/victim')
    await writeFile(join(folder, 'data'), bytes)
    await writeFile(
      join(folder, 'intent.json'),
      JSON.stringify({ path: 'file', expected, effect: 'write', receipt: 'published' })
    )
    await link(join(folder, 'data'), join(root, 'file'))
    await fs.recoverConditionalFiles()
    expect(await fs.installedFile('published', 'file', await sha256(bytes))).toBe(true)
    await expect(readFile(join(root, 'file.sync-conflict-published'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'retires allocation-only capture sentinels without restoring empty user files (%s)',
  async (journaled) => {
    const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
    try {
      const folder = join(root, '.abele-sync/conditional/allocated')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'victim'), new Uint8Array())
      const info = await lstat(join(folder, 'victim'))
      if (journaled)
        await writeFile(
          join(folder, 'intent.json'),
          JSON.stringify({ path: 'file', sentinel: { dev: info.dev, ino: info.ino } })
        )
      const fs = new NodeFileSystem(root)
      await fs.recoverConditionalFiles()
      expect(await fs.stat('file')).toBeNull()
      expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('preserves a captured edit if restoration fails because its public parent disappeared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quarantine-'))
  try {
    const folder = join(root, '.abele-sync/conditional/failed-restore')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'victim'), new Uint8Array([3]))
    await writeFile(join(folder, 'intent.json'), JSON.stringify({ path: 'missing/file' }))
    const fs = new NodeFileSystem(root)
    await fs.recoverConditionalFiles()
    await fs.recoverConditionalFiles()
    expect(
      new Uint8Array(await readFile(join(root, 'Recovered.sync-conflict-failed-restore')))
    ).toEqual(new Uint8Array([3]))
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
