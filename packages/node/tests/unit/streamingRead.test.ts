import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NodeFileSystem } from '../../src/index.js'
import { SettlingFileSystem } from '../../src/index.js'
import { fingerprintFile, sha256 } from '@abele/sync-core'

it('retains native streaming capabilities through the CLI settling wrapper', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stream-wrapper-'))
  try {
    const disk = new NodeFileSystem(root)
    await disk.writeAtomic('original', new Uint8Array([1]), 1000)
    disk.read = async () => {
      throw new Error('whole read forbidden')
    }
    const fs = new SettlingFileSystem(disk)
    expect((await fingerprintFile(fs, 'original', sha256)).size).toBe(1)
    const source = await fs.openRead!('original')
    await source.close()
    const stage = await fs.beginAtomicWrite!('next', 1000, null)
    await stage.append(0, new Uint8Array([2]))
    const reopened = await fs.reopenStage!(stage.id)
    await reopened.seal({ size: 1, sha: await sha256(new Uint8Array([2])) })
    await reopened.commit()
    expect((await fingerprintFile(fs, 'next', sha256)).sha).toBe(await sha256(new Uint8Array([2])))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reads bounded ranges and rejects a changed source stamp', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stream-read-'))
  try {
    await writeFile(join(root, 'file'), new Uint8Array(1024 * 1024 + 3).fill(7))
    const fs = new NodeFileSystem(root)
    const source = await fs.openRead('file')
    try {
      expect((await source.read(1024 * 1024, 3)).length).toBe(3)
      await expect(source.read(0, 1024 * 1024 + 1)).rejects.toThrow()
      await writeFile(join(root, 'file'), new Uint8Array(2))
      await expect(source.assertUnchanged()).rejects.toThrow()
    } finally {
      await source.close()
    }
    expect((await fs.fingerprint('file')).size).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
