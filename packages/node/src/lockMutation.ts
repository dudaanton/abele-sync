import { mkdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'

/**
 * Serialize all changes to a lock name, including publication of its identity.
 * There is no portable compare-and-unlink: renaming aside before checking the
 * owner exposes a live holder's name. An exclusive directory covers the entire
 * check/change instead and works on filesystems without hard links.
 *
 * Never steal this guard on a timeout: a stopped process could resume inside
 * its critical section. A crash here fails closed. After stopping every sync
 * process sharing this folder, an operator may remove the empty .mutation dir.
 */
export function mutateLock<T>(file: string, work: () => T): { value: T } | null {
  const guard = `${file}.mutation`
  try {
    mkdirSync(guard, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw error
  }
  try {
    return { value: work() }
  } finally {
    rmdirSync(guard)
  }
}

export function removeIf(file: string, mine: (text: string) => boolean): void {
  mutateLock(file, () => {
    try {
      if (mine(readFileSync(file, 'utf8'))) unlinkSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  })
}
