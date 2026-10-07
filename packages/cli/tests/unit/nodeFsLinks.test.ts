import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeText } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'

/**
 * Links where the adapter works, and folders swapped for links while it works.
 *
 * The engine's own folder is inside the vault, so it can be a link as well as any vault
 * folder, and nothing the adapter writes or sweeps there may go through one. And a folder the
 * adapter has just found to be real can be renamed away and replaced with a link before the
 * operation it was checked for runs: the adapter looks again right before it acts, and a read
 * checks that what it opened is the file it looked at.
 */

/**
 * Run once, the next time the adapter touches `path` with `call`: before the call goes on, or
 * with `after`, once it has answered and before the adapter sees the answer.
 */
const hooks = vi.hoisted(() => ({
  next: null as null | { call: string; path: string; run: () => Promise<void>; after?: boolean },
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const hooked = <F extends (...args: never[]) => Promise<unknown>>(call: string, real: F): F =>
    (async (...args: Parameters<F>) => {
      const hook = hooks.next
      if (hook === null || hook.call !== call || String(args[0]) !== hook.path) {
        return real(...args)
      }
      hooks.next = null
      if (hook.after !== true) {
        await hook.run()
        return real(...args)
      }
      const answer = await real(...args)
      await hook.run()
      return answer
    }) as F
  const lstat = hooked('lstat', actual.lstat)
  const utimes = hooked('utimes', actual.utimes)
  return { ...actual, default: { ...actual, lstat, utimes }, lstat, utimes }
})

const bytes = (s: string) => encodeText(s)

let root: string
let outside: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'abele-links-'))
  outside = await mkdtemp(join(tmpdir(), 'abele-outside-'))
  await writeFile(join(outside, 'keep.md'), 'outside')
})
afterEach(async () => {
  hooks.next = null
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

/** `Notes` renamed away and a link to the outside put in its place. */
const swapNotes = async (): Promise<void> => {
  await rename(join(root, 'Notes'), join(root, 'Notes.real'))
  await symlink(outside, join(root, 'Notes'))
}

describe('the engine’s own folder', () => {
  it('sweeps nothing through a temp folder that is a link', async () => {
    await mkdir(join(root, '.abele-sync'))
    await symlink(outside, join(root, '.abele-sync', 'tmp'))
    new NodeFileSystem(root).sweepTemp()
    new NodeFileSystem(root).removeTemp()
    expect(await readdir(outside)).toEqual(['keep.md'])
  })

  it('sweeps nothing through an engine folder that is a link', async () => {
    await mkdir(join(outside, 'tmp'))
    await writeFile(join(outside, 'tmp', 'other.bin'), 'theirs')
    await symlink(outside, join(root, '.abele-sync'))
    new NodeFileSystem(root).sweepTemp()
    new NodeFileSystem(root).removeTemp()
    expect(await readdir(join(outside, 'tmp'))).toEqual(['other.bin'])
  })

  it('writes nothing through a temp folder or an engine folder that is a link', async () => {
    await mkdir(join(root, '.abele-sync'))
    await symlink(outside, join(root, '.abele-sync', 'tmp'))
    await expect(
      new NodeFileSystem(root).writeAtomic('a.md', bytes('a'), 1000)
    ).rejects.toMatchObject({ code: 'conflict' })
    await rm(join(root, '.abele-sync'), { recursive: true })
    await symlink(outside, join(root, '.abele-sync'))
    await expect(
      new NodeFileSystem(root).writeAtomic('a.md', bytes('a'), 1000)
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await readdir(outside)).toEqual(['keep.md'])
  })
})

describe('a folder swapped for a link mid-operation', () => {
  it('does not write through it', async () => {
    await mkdir(join(root, 'Notes'))
    const fs = new NodeFileSystem(root)
    // The temp file has been written and is being dated: the checks are behind us.
    hooks.next = { call: 'utimes', path: '', run: swapNotes }
    const temp = fs as unknown as { tempPath(): Promise<string> }
    const tempPath = temp.tempPath.bind(fs)
    temp.tempPath = async () => {
      const path = await tempPath()
      if (hooks.next !== null) hooks.next.path = path
      return path
    }
    await expect(fs.writeAtomic('Notes/keep.md', bytes('pwned'), 1000)).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('outside')
  })

  it('does not remove through it', async () => {
    await mkdir(join(root, 'Notes'))
    await writeFile(join(root, 'Notes', 'keep.md'), 'inside')
    const fs = new NodeFileSystem(root)
    // The file itself is being looked at: its folders were found real a moment ago.
    hooks.next = { call: 'lstat', path: join(root, 'Notes', 'keep.md'), run: swapNotes }
    await expect(fs.remove('Notes/keep.md')).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('outside')
  })

  it('does not read through it', async () => {
    await mkdir(join(root, 'Notes'))
    await writeFile(join(root, 'Notes', 'keep.md'), 'inside')
    const fs = new NodeFileSystem(root)
    // `Notes` is found to be a folder, and is a link by the time the file is opened.
    const notes = join(root, 'Notes')
    hooks.next = { call: 'lstat', path: notes, run: swapNotes, after: true }
    const read = await fs.read('Notes/keep.md').then(
      (b) => new TextDecoder().decode(b),
      (error: unknown) => error
    )
    expect(read).not.toBe('outside')
  })
})
