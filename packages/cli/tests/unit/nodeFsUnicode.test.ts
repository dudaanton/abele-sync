import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LocalPaths } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'

let root: string
let fs: NodeFileSystem
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'abele-unicode-'))
  fs = new NodeFileSystem(root, { preserveEmptyDirectories: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('resolves raw mixed parents through immediate children without listing the whole tree', async () => {
  const parent = 'й'.normalize('NFD') + '/ё-é'
  await mkdir(join(root, parent), { recursive: true })
  await writeFile(join(root, parent, 'local.md'), 'bytes')
  fs.list = async function* () {
    throw new Error('whole-tree file scan forbidden')
  }
  fs.listDirectories = async function* () {
    throw new Error('whole-tree directory scan forbidden')
  }
  const paths = await LocalPaths.forPath(fs, 'й/ё-é/new.md')
  expect(paths.resolve('й/ё-é/new.md', 'file')).toBe(parent + '/new.md')
})

it('checks removal identity and keeps a replacement empty directory', async () => {
  await fs.mkdir('й')
  const original = (await fs.listChildren('')).find((entry) => entry.path === 'й')!
  await rename(join(root, 'й'), join(root, 'old'))
  await fs.mkdir('й')
  await expect(fs.removeDirectory('й', original.identity)).rejects.toThrow('identity changed')
  expect(await readdir(root)).toContain('й')
})

it('refuses raw child enumeration through an empty symlink directory', async () => {
  await mkdir(join(root, 'real'))
  await symlink(join(root, 'real'), join(root, 'linked'))
  await expect(fs.listChildren('linked')).rejects.toThrow('not a real directory')
})

it('permits a directory normalization rename while refusing a distinct destination identity', async () => {
  const raw = 'й'.normalize('NFD')
  await fs.mkdir(raw)
  await writeFile(join(root, raw, 'ё.md'), 'bytes')
  await fs.moveDirectory(raw, 'й')
  expect(new TextDecoder().decode(await fs.read('й/ё.md'))).toBe('bytes')
  await fs.mkdir('Other')
  await expect(fs.moveDirectory('й', 'Other')).rejects.toThrow('already exists')
})
