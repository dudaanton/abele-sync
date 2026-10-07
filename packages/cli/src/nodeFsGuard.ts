import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { EngineError } from '@abele/sync-core'

/**
 * What keeps `NodeFileSystem` inside the vault: paths that cannot leave it by their spelling,
 * folders that are real folders and not links to somewhere else, and an engine folder that is
 * the vault's own.
 *
 * Node has no `openat`, so a folder checked here can still be renamed away and replaced with a
 * link before the operation it was checked for runs. The adapter narrows that to what it can:
 * it checks again right before each rename and unlink, and a read makes sure the file it opened
 * is the one it looked at. What is left is the gap between that last look and the call itself,
 * which only a process already able to write inside the vault can use, and only by winning a
 * race of a few microseconds.
 */

/**
 * `path` under `base`, with the separators this platform uses and no way out of the vault.
 *
 * A vault path is `/`-separated, so a segment carrying a backslash is refused rather than
 * split: on Windows `'..\\escape.md'` is one segment here and a way out of the vault there.
 * The resolved result is checked against the root as well, so nothing the segment rules miss
 * can still land outside.
 */
export function absoluteIn(base: string, path: string): string {
  const segments = path.split('/')
  if (path === '' || path.startsWith('/') || segments.some(isTraversal)) {
    throw new EngineError('io', `path outside the vault: ${path}`)
  }
  const target = join(base, ...segments)
  if (!resolve(target).startsWith(base + sep)) {
    throw new EngineError('io', `path outside the vault: ${path}`)
  }
  return target
}

/**
 * `absoluteIn(base, path)`, once every folder between the root and it is known to be a real
 * folder.
 *
 * The string alone keeps a path inside the vault; a folder that has been swapped for a link
 * (or a junction) would still carry every read, write, move and delete through it to wherever
 * it points. So each existing ancestor is looked at itself, never followed, and a link among
 * them is refused as `conflict`: the engine holds the change and logs it, and nothing outside
 * is touched. A missing ancestor ends the climb — `mkdir` makes real folders from there — and
 * so does a file where a folder should be, which the operation itself then fails on.
 *
 * The root itself may be a link (a vault opened through one is still that vault); only what
 * lies beneath it is checked.
 */
export async function containedIn(base: string, path: string): Promise<string> {
  const target = absoluteIn(base, path)
  const folders = path.split('/').slice(0, -1)
  let current = base
  for (let i = 0; i < folders.length; i++) {
    current = join(current, folders[i]!)
    let stats
    try {
      stats = await lstat(current)
    } catch (cause) {
      if (isMissing(cause)) break
      throw new EngineError('io', `cannot look at ${folders.slice(0, i + 1).join('/')}`, cause)
    }
    if (stats.isSymbolicLink()) {
      const folder = folders.slice(0, i + 1).join('/')
      throw new EngineError(
        'conflict',
        `a link is at ${folder}, above ${path}; nothing beneath it is touched`
      )
    }
    if (!stats.isDirectory()) break
  }
  return target
}

/**
 * The engine's temp folder, `<base>/<stateDir>/tmp`, made where it is missing — and refused as
 * `conflict` where either folder is a link or not a folder, so nothing the adapter writes on
 * its way through lands outside the vault. Made one level at a time, never with `recursive`,
 * which would follow a link it met on the way.
 */
export async function ownTempFolder(base: string, stateDir: string, tmp: string): Promise<string> {
  let current = base
  for (const name of [stateDir, tmp]) {
    current = join(current, name)
    let stats
    try {
      stats = await lstat(current)
    } catch (cause) {
      if (!isMissing(cause)) throw new EngineError('io', `cannot look at ${stateDir}`, cause)
      try {
        await mkdir(current)
      } catch (made) {
        if ((made as { code?: string }).code !== 'EEXIST') {
          throw new EngineError('io', `cannot create ${stateDir}/${tmp}`, made)
        }
      }
      stats = await lstat(current)
    }
    if (!stats.isDirectory()) {
      throw new EngineError(
        'conflict',
        `${stats.isSymbolicLink() ? 'a link' : 'something'} is at ${current.slice(base.length + 1)}, ` +
          'where the engine keeps its temp files; nothing is written through it'
      )
    }
  }
  return current
}

/**
 * The temp folder, when both it and the engine folder above it are real folders; null when
 * either is missing or is anything else. What sweeps and removes it looks here first, so it
 * never reaches through a link.
 */
export function realTempFolder(base: string, stateDir: string, tmp: string): string | null {
  let current = base
  for (const name of [stateDir, tmp]) {
    current = join(current, name)
    try {
      if (!lstatSync(current).isDirectory()) return null
    } catch {
      return null
    }
  }
  return current
}

/**
 * Clears whatever a killed process left in the temp folder. One vault is held by one daemon —
 * the lock sees to that — so, called under the lock, nothing here is anybody's work in progress.
 */
export function sweepTempFolder(folder: string | null): void {
  if (folder === null) return
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return
  }
  for (const name of names) {
    try {
      // Only what the folder itself holds, by name: a symlink is unlinked, never followed.
      rmSync(join(folder, name), { recursive: true, force: true })
    } catch {
      /* a leftover we cannot remove is not worth failing a start over */
    }
  }
}

const isTraversal = (segment: string): boolean =>
  segment === '' || segment === '.' || segment === '..' || segment.includes('\\')

export const isMissing = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  ((cause as { code?: string }).code === 'ENOENT' ||
    (cause as { code?: string }).code === 'ENOTDIR')
