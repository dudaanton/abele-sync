import { open } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Fail closed when the filesystem cannot promise durability; never advance the ledger then. */
export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Persist the new name and any newly-created ancestors, through the existing vault root. */
export async function syncParents(files: string | readonly string[], root: string): Promise<void> {
  const directories = new Set<string>()
  for (const file of typeof files === 'string' ? [files] : files) {
    let dir = dirname(file)
    for (;;) {
      directories.add(dir)
      if (dir === root) break
      const parent = dirname(dir)
      if (parent === dir) throw new Error('durability path escaped the vault')
      dir = parent
    }
  }
  // All namespace changes precede this barrier. Flush children before ancestors,
  // including a shared ancestor only once; never reuse this set across barriers.
  for (const dir of [...directories].sort((a, b) => b.length - a.length)) await syncPath(dir)
}
