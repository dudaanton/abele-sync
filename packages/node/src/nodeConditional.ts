import { randomBytes, createHash } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  utimes,
  writeFile,
  readdir,
  readFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ConditionalFileOperation } from '@abele/sync-core'
import { containedIn, isMissing } from './nodeFsGuard.js'
import { syncParents, syncPath } from './nodeFsDurability.js'

async function fingerprint(path: string) {
  const file = await open(path, 'r'),
    hash = createHash('sha256')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await file.read(buffer)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}
function valid(id: string) {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('invalid installation receipt')
  return id
}

/** Never rename over a public name. Capture first, validate the displaced inode,
 * publish/restore exclusively. Quarantines are durable review records, never temp-swept. */
export async function conditionalFile(
  root: string,
  op: ConditionalFileOperation,
  check: () => void
): Promise<boolean> {
  const id = valid(
    op.effect.kind === 'write' && op.effect.receipt
      ? op.effect.receipt
      : randomBytes(16).toString('hex')
  )
  const directory = await containedIn(root, `.abele-sync/conditional/${id}`)
  await mkdir(directory, { recursive: true })
  const victim = await containedIn(root, `.abele-sync/conditional/${id}/victim`)
  const target = await containedIn(root, op.path)
  await writeFile(
    `${directory}/intent.json`,
    JSON.stringify({ path: op.path, expected: op.expected, effect: op.effect.kind }),
    { flag: 'wx' }
  )
  await syncPath(`${directory}/intent.json`)
  await syncParents(`${directory}/intent.json`, root)
  let captured = false
  const restore = async () => {
    if (!captured) return
    check()
    await link(victim, await containedIn(root, op.path)).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
    await syncParents([victim, target], root)
  }
  const completed = async () => {
    await writeFile(`${directory}/complete`, '1', { flag: 'wx' })
    await syncPath(`${directory}/complete`)
    await syncParents(`${directory}/complete`, root)
    const done = await containedIn(root, `.abele-sync/conditional-complete/${id}`)
    await mkdir(dirname(done), { recursive: true })
    await rename(directory, done)
    await syncParents([done, directory], root)
  }
  try {
    check()
    if (op.expected !== null) {
      try {
        await rename(await containedIn(root, op.path), victim)
        captured = true
      } catch (error) {
        if (isMissing(error)) {
          if (op.effect.kind !== 'remove') return false
          await completed()
          return true
        }
        throw error
      }
      await syncParents([victim, target], root)
      const info = await lstat(victim)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== op.expected.size ||
        Math.max(0, Math.round(info.mtimeMs)) !== op.expected.mtime ||
        (await fingerprint(victim)) !== op.expected.sha
      ) {
        await restore()
        return false
      }
    } else {
      try {
        await lstat(target)
        return false
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    check()
    if (op.effect.kind === 'remove') {
      await completed()
      return true
    }
    const destination = await containedIn(root, op.effect.kind === 'move' ? op.effect.to : op.path)
    await mkdir(dirname(destination), { recursive: true })
    let data = victim
    if (op.effect.kind === 'write') {
      data = `${directory}/data`
      await writeFile(data, op.effect.bytes, { flag: 'wx' })
      await utimes(data, new Date(op.effect.mtime), new Date(op.effect.mtime))
      await syncPath(data)
      await syncParents(data, root)
    } else if (op.effect.kind === 'install') {
      data = await containedIn(root, `.abele-sync/stages/${valid(op.effect.stageId)}/data`)
    } else if (!captured) return false
    check()
    try {
      await link(data, destination)
    } catch (error) {
      await restore()
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    await syncParents(destination, root)
    await completed()
    return true
  } catch (error) {
    await restore()
    throw error
  }
}

export async function recoverConditionalFiles(root: string, check: () => void): Promise<void> {
  const directory = await containedIn(root, '.abele-sync/conditional')
  let ids: string[]
  try {
    ids = await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  for (const id of ids) {
    const folder = await containedIn(root, `.abele-sync/conditional/${valid(id)}`)
    try {
      await lstat(`${folder}/complete`)
      const done = await containedIn(root, `.abele-sync/conditional-complete/${id}`)
      await mkdir(dirname(done), { recursive: true })
      check()
      await rename(folder, done)
      await syncParents([folder, done], root)
      continue
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    try {
      const intent = JSON.parse(await readFile(`${folder}/intent.json`, 'utf8')) as { path: string }
      const target = await containedIn(root, intent.path),
        victim = await containedIn(root, `.abele-sync/conditional/${id}/victim`)
      const info = await lstat(victim)
      if (!info.isFile() || info.isSymbolicLink()) continue
      check()
      await link(victim, target).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
      await syncParents(target, root)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}

export async function installedFile(
  root: string,
  receipt: string,
  path: string,
  sha: string
): Promise<boolean> {
  try {
    let data = await containedIn(root, `.abele-sync/conditional-complete/${valid(receipt)}/data`)
    try {
      await lstat(data)
    } catch (error) {
      if (!isMissing(error)) throw error
      data = await containedIn(root, `.abele-sync/conditional/${valid(receipt)}/data`)
    }
    const target = await containedIn(root, path)
    const [a, b] = await Promise.all([lstat(data), lstat(target)])
    return (
      a.isFile() &&
      b.isFile() &&
      a.ino === b.ino &&
      a.dev === b.dev &&
      (await fingerprint(target)) === sha
    )
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}
