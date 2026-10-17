import { mkdtemp, rm, writeFile, readFile, rename, link, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sha256, type FileSystem } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/index.js'

it('preserves a replacement save made after base validation but before publication', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stage-late-save-'))
  try {
    const fs = new NodeFileSystem(root)
    await writeFile(join(root, 'file'), new Uint8Array([1]))
    const base = await fs.fingerprint('file')
    const stage = await fs.beginAtomicWrite('file', 1000, base)
    await stage.append(0, new Uint8Array([2]))
    await stage.seal({ size: 1, sha: await sha256(new Uint8Array([2])) })
    const fingerprint = fs.fingerprint.bind(fs)
    let saved = false
    fs.fingerprint = async (...args) => {
      const result = await fingerprint(...args)
      if (args[0] === 'file' && !saved) {
        saved = true
        // Simulate an editor's atomic save after the last base read completed.
        await writeFile(join(root, 'editor-save'), new Uint8Array([3]))
        await rename(join(root, 'editor-save'), join(root, 'file'))
      }
      return result
    }
    await expect(stage.commit()).rejects.toThrow('displaced stage base changed')
    expect(saved).toBe(true)
    expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([3]))
    expect(await readFile(join(root, '.abele-sync/stages', stage.id, 'base'))).toEqual(
      Buffer.from([3])
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('restarts an append from its durable checkpoint and truncates uncheckpointed bytes', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stage-append-crash-'))
  try {
    const fs = new NodeFileSystem(root)
    const stage = await fs.beginAtomicWrite('file', 1000, null)
    await stage.append(0, new Uint8Array([1]))
    await appendFile(join(root, '.abele-sync/stages', stage.id, 'data'), new Uint8Array([99, 88]))
    const restarted = new NodeFileSystem(root)
    const reopened = await restarted.reopenStage(stage.id)
    expect(reopened.offset).toBe(1)
    expect(await restarted.stat('file')).toBeNull()
    await reopened.append(1, new Uint8Array([2]))
    await reopened.seal({ size: 2, sha: await sha256(new Uint8Array([1, 2])) })
    await reopened.commit()
    expect(await restarted.read('file')).toEqual(new Uint8Array([1, 2]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not reseal a published stage after an independent editor changed its linked inode', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stage-edit-'))
  try {
    const fs = new NodeFileSystem(root)
    const expected = { size: 1, sha: await sha256(new Uint8Array([1])) }
    const stage = await fs.beginAtomicWrite('file', 1000, null)
    await stage.append(0, new Uint8Array([1]))
    await stage.seal(expected)
    await stage.commit()
    await writeFile(join(root, 'file'), new Uint8Array([2]))
    const reopened = await new NodeFileSystem(root).reopenStage(stage.id)
    await expect(reopened.seal(expected)).rejects.toThrow()
    expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([2]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const phase of ['installing', 'displaced', 'published'] as const) {
  it(`reopens an atomic replacement after a crash at ${phase}`, async () => {
    const root = await mkdtemp(join(process.cwd(), '.stage-crash-'))
    try {
      const fs = new NodeFileSystem(root)
      const base = new Uint8Array([1]),
        next = new Uint8Array([2])
      await fs.writeAtomic('file', base, 1000)
      const stage = await fs.beginAtomicWrite('file', 2000, { size: 1, sha: await sha256(base) })
      await stage.append(0, next)
      await stage.seal({ size: 1, sha: await sha256(next) })
      const dir = join(root, '.abele-sync/stages', stage.id)
      const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))
      meta.phase = 'installing'
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta))
      if (phase !== 'installing') await rename(join(root, 'file'), join(dir, 'base'))
      if (phase === 'published') await link(join(dir, 'data'), join(root, 'file'))
      const reopened = await new NodeFileSystem(root).reopenStage(stage.id)
      await reopened.commit()
      await reopened.commit()
      expect(await readFile(join(root, 'file'))).toEqual(Buffer.from(next))
      expect(await readFile(join(dir, 'base'))).toEqual(Buffer.from(base))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

it('BUG: Node stages enforce contiguous writes and exact sealing before publication', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stage-spec-'))
  try {
    const fs: FileSystem = new NodeFileSystem(root)
    const stage = await fs.beginAtomicWrite!('file', 1000, null)
    const bytes = new Uint8Array([1, 2, 3])
    await expect(stage.append(1, bytes)).rejects.toThrow()
    expect(await fs.stat('file')).toBeNull()
    await stage.append(0, bytes)
    await expect(stage.seal({ size: 3, sha: '0'.repeat(64) })).rejects.toThrow()
    await expect(stage.commit()).rejects.toThrow()
    expect(await fs.stat('file')).toBeNull()
    await stage.seal({ size: 3, sha: await sha256(bytes) })
    await stage.commit()
    expect(await fs.read('file')).toEqual(bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('BUG: Node stages reopen from persisted ids without appearing in scans', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stage-spec-'))
  try {
    const fs: FileSystem = new NodeFileSystem(root)
    const stage = await fs.beginAtomicWrite!('file', 1000, null)
    await stage.append(0, new Uint8Array([1]))
    const restarted: FileSystem = new NodeFileSystem(root)
    const listed = []
    for await (const info of restarted.list()) listed.push(info)
    expect(listed).toEqual([])
    const reopened = await restarted.reopenStage!(stage.id)
    expect(reopened.offset).toBe(1)
    await reopened.append(1, new Uint8Array([2]))
    await reopened.seal({ size: 2, sha: await sha256(new Uint8Array([1, 2])) })
    await reopened.commit()
    expect(await restarted.read('file')).toEqual(new Uint8Array([1, 2]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('BUG: Node stage replacement preserves edits made after the expected base was captured', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stage-spec-'))
  try {
    const fs: FileSystem = new NodeFileSystem(root)
    const before = new Uint8Array([1])
    await writeFile(join(root, 'file'), before)
    const stage = await fs.beginAtomicWrite!('file', 1000, { size: 1, sha: await sha256(before) })
    await stage.append(0, new Uint8Array([2]))
    await stage.seal({ size: 1, sha: await sha256(new Uint8Array([2])) })
    await writeFile(join(root, 'file'), new Uint8Array([3]))
    await expect(stage.commit()).rejects.toThrow()
    expect(await readFile(join(root, 'file'))).toEqual(Buffer.from([3]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
