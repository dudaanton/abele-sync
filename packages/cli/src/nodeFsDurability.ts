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
export async function syncParents(file: string, root: string): Promise<void> {
  let dir = dirname(file)
  for (;;) {
    await syncPath(dir)
    if (dir === root) return
    const parent = dirname(dir)
    if (parent === dir) throw new Error('durability path escaped the vault')
    dir = parent
  }
}
