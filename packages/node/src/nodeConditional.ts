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
  unlink,
  rm,
  rmdir,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ConditionalFileOperation, FileVersion, RemovalPublication } from '@abele/sync-core'
import { containedIn, isMissing } from './nodeFsGuard.js'
import { syncParents, syncPath } from './nodeFsDurability.js'

export async function fileObjectIdentity(path: string): Promise<string | null> {
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.birthtimeNs <= 0n) return null
    return `${info.dev}:${info.ino}:${info.birthtimeNs}`
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

async function fingerprint(path: string, limit: number) {
  const file = await open(path, 'r'),
    hash = createHash('sha256')
  try {
    // Tiny victims dominate recovery. Read one byte beyond the expected size to
    // detect growth without allocating a megabyte for every small-file check.
    const buffer = Buffer.alloc(Math.max(1, Math.min(1024 * 1024, limit + 1)))
    let size = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer)
      if (!bytesRead) break
      size += bytesRead
      if (size > limit) return 'changed'
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

/** Final bounded content proof, including writes which preserve rounded stat fields.
 * POSIX has no compare-and-unlink: the caller must unlink immediately after this
 * resolves and preserve the capture on any mismatch or I/O uncertainty. */
export async function matchesVictim(path: string, expected: FileVersion): Promise<boolean> {
  if (expected.identity !== undefined && (await fileObjectIdentity(path)) !== expected.identity)
    return false
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.size !== BigInt(expected.size) ||
    Math.max(0, Math.round(Number(before.mtimeNs) / 1e6)) !== expected.mtime
  )
    return false
  const sha = await fingerprint(path, expected.size)
  const after = await lstat(path, { bigint: true })
  return (
    sha === expected.sha &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}
function valid(id: string) {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('invalid installation receipt')
  return id
}

export async function restoreVictim(
  root: string,
  path: string,
  victim: string,
  id: string,
  removal = false
) {
  const target = await containedIn(root, path),
    info = await lstat(victim)
  let destination = target
  const retainedPath = async (suffix = '') => {
    const name = await containedIn(
      root,
      removal
        ? `.abele-sync/retained-removals/${id}${suffix}/${path}`
        : `${path}.sync-conflict-${id}${suffix}`
    )
    if (removal) await mkdir(dirname(name), { recursive: true })
    return name
  }
  if (info.isDirectory()) {
    // Recovery of old adapters which could capture a directory. Reserve an empty
    // destination exclusively; rename cannot replace a directory containing a save.
    try {
      await mkdir(destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      destination = await retainedPath()
      await mkdir(destination)
    }
    await rename(victim, destination)
  } else {
    try {
      await link(victim, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const named = await lstat(destination)
      if (named.dev !== info.dev || named.ino !== info.ino) {
        for (let n = 0; ; n++) {
          destination = await retainedPath(n ? `-${n}` : '')
          try {
            await link(victim, destination)
            break
          } catch (conflict) {
            if ((conflict as NodeJS.ErrnoException).code !== 'EEXIST') throw conflict
            const restored = await lstat(destination)
            if (restored.dev === info.dev && restored.ino === info.ino) break
          }
        }
      }
    }
    // The public name must survive a crash before its only backup is retired.
    await syncParents(destination, root)
    await unlink(victim)
  }
  await syncParents(destination, root)
  await syncParents(victim, root)
}

async function restoring(folder: string, root: string) {
  await writeFile(`${folder}/restoring`, '1')
  await syncPath(`${folder}/restoring`)
  await syncParents(`${folder}/restoring`, root)
}
export type RetainVictim = (
  source: string,
  path: string,
  expected: FileVersion,
  publication?: RemovalPublication
) => Promise<void>

/** Never rename over a public name. Capture first, validate the displaced inode,
 * publish/restore exclusively. Victims are dropped on success or restored and retired
 * on refusal; publication receipts own only the newly installed data. */
export async function conditionalFile(
  root: string,
  op: ConditionalFileOperation,
  check: () => void,
  retain?: RetainVictim
): Promise<boolean> {
  // Captured removals are owned by retainRemoval through NodeFileSystem. This
  // low-level primitive may only acknowledge absence; never unlink a victim
  // based on an async authorization callback.
  if (op.effect.kind === 'remove' && op.expected !== null) return false
  if (op.authorize && op.effect.kind !== 'remove')
    throw new Error('conditional ownership is only supported for removal')
  const id = valid(
    op.effect.kind === 'write' && op.effect.receipt
      ? op.effect.receipt
      : randomBytes(16).toString('hex')
  )
  const directory = await containedIn(root, `.abele-sync/conditional/${id}`)
  await mkdir(directory, { recursive: true })
  const victim = await containedIn(root, `.abele-sync/conditional/${id}/victim`)
  const target = await containedIn(root, op.path)
  // rename(directory, existingRegularFile) is rejected by the filesystem itself.
  // Its inode also distinguishes allocation-only crashes from a captured empty file.
  let sentinel: { dev: number; ino: number } | undefined
  if (op.expected !== null) {
    await writeFile(victim, new Uint8Array(), { flag: 'wx' })
    const info = await lstat(victim)
    sentinel = { dev: info.dev, ino: info.ino }
  }
  await writeFile(
    `${directory}/intent.json`,
    JSON.stringify({
      sentinel,
      path: op.path,
      expected: op.expected,
      effect: op.effect.kind,
      to: op.effect.kind === 'move' ? op.effect.to : undefined,
      receipt: op.effect.kind === 'write' ? op.effect.receipt : undefined,
      stageId: op.effect.kind === 'install' ? op.effect.stageId : undefined,
    }),
    { flag: 'wx' }
  )
  await syncPath(`${directory}/intent.json`)
  await syncParents(`${directory}/intent.json`, root)
  let captured = false
  let published = false
  const retire = async () => {
    await rm(directory, { recursive: true, force: true })
    await syncPath(dirname(directory))
  }
  const restore = async () => {
    if (!captured) {
      if (!published) await retire()
      return
    }
    check()
    await restoring(directory, root)
    await restoreVictim(root, op.path, victim, id, op.effect.kind === 'remove')
    captured = false
    await retire()
  }
  const completed = async () => {
    if (captured) {
      if (op.expected === null || !(await matchesVictim(victim, op.expected))) {
        await restore()
        return false
      }
      // Captured removals cannot reach this publication-only retirement path.
      // Their bytes and durable decision belong to removalRetention instead.
      if (retain && op.effect.kind !== 'move')
        await retain(
          `.abele-sync/conditional/${id}/victim`,
          op.path,
          op.expected,
          op.effect.kind === 'write' && op.effect.receipt
            ? { kind: 'installation', id: op.effect.receipt }
            : op.effect.kind === 'install'
              ? { kind: 'stage', id: op.effect.stageId }
              : undefined
        )
      else await unlink(victim)
      captured = false
      await syncParents(victim, root)
    } else if (op.authorize && !(await op.authorize())) {
      await retire()
      return false
    }
    if (op.effect.kind !== 'write' || !op.effect.receipt) {
      await retire()
      return true
    }
    await writeFile(`${directory}/complete`, '1', { flag: 'wx' })
    await syncPath(`${directory}/complete`)
    await syncParents(`${directory}/complete`, root)
    const done = await containedIn(root, `.abele-sync/installations/${id}`)
    await mkdir(dirname(done), { recursive: true })
    await rename(directory, done)
    await syncParents([done, directory], root)
    return true
  }
  try {
    check()
    if (op.expected !== null) {
      try {
        const source = await containedIn(root, op.path)
        check()
        const sourceInfo = await lstat(source)
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
          await retire()
          return false
        }
        check()
        await rename(source, victim)
        captured = true
      } catch (error) {
        if (['ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          await retire()
          return false
        }
        if (isMissing(error)) {
          if (op.effect.kind !== 'remove') {
            await retire()
            return false
          }
          return await completed()
        }
        throw error
      }
      await syncParents([victim, target], root)
      const info = await lstat(victim)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (op.expected.identity !== undefined &&
          (await fileObjectIdentity(victim)) !== op.expected.identity) ||
        info.size !== op.expected.size ||
        Math.max(0, Math.round(info.mtimeMs)) !== op.expected.mtime ||
        (await fingerprint(victim, op.expected.size)) !== op.expected.sha
      ) {
        await restore()
        return false
      }
    } else {
      try {
        await lstat(target)
        await retire()
        return false
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    check()
    if (op.effect.kind === 'remove') {
      return await completed()
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
    } else if (!captured) {
      await retire()
      return false
    }
    check()
    // Preparing the destination/data yielded after capture. Do not publish
    // against a baseline that changed while those operations were pending.
    if (captured && op.expected !== null && !(await matchesVictim(victim, op.expected))) {
      await restore()
      return false
    }
    try {
      await link(data, destination)
      published = true
    } catch (error) {
      await restore()
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    await syncParents(destination, root)
    return await completed()
  } catch (error) {
    await restore()
    throw error
  }
}

export async function recoverConditionalFiles(
  root: string,
  check: () => void,
  retain?: RetainVictim
): Promise<void> {
  for (const location of ['conditional', 'conditional-complete'])
    await recoverFolder(root, location, check, retain)
}

/** One-time adoption of the pre-owner retention layout. These bytes have no
 * committed reclamation authority, so restore/expose them instead of deleting. */
export async function recoverLegacyRetention(root: string, check: () => void): Promise<void> {
  const directory = await containedIn(root, '.abele-sync/retained-removals')
  try {
    await lstat(`${directory}/summary.json`)
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  let ids: string[]
  try {
    ids = await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  for (const id of ids) {
    valid(id)
    const walk = async (relative: string): Promise<void> => {
      const folder = await containedIn(
        root,
        `.abele-sync/retained-removals/${id}${relative ? `/${relative}` : ''}`
      )
      const info = await lstat(folder)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('invalid legacy retention folder')
      for (const name of await readdir(folder)) {
        const path = relative ? `${relative}/${name}` : name
        const victim = await containedIn(root, `.abele-sync/retained-removals/${id}/${path}`)
        const stat = await lstat(victim)
        check()
        if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(path)
        else if (stat.isFile() && !stat.isSymbolicLink())
          await restoreVictim(root, path, victim, id)
        else throw new Error('invalid legacy retained object')
      }
      await rmdir(folder)
    }
    await walk('')
  }
  await writeFile(`${directory}/summary.json`, '[]', { flag: 'wx' })
  await syncPath(`${directory}/summary.json`)
  await syncParents(`${directory}/summary.json`, root)
}

async function recoverFolder(
  root: string,
  location: string,
  check: () => void,
  retain?: RetainVictim
): Promise<void> {
  const directory = await containedIn(root, `.abele-sync/${location}`)
  let ids: string[]
  try {
    ids = await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  for (const id of ids) {
    const folder = await containedIn(root, `.abele-sync/${location}/${valid(id)}`)
    let complete = false
    try {
      await lstat(`${folder}/complete`)
      complete = true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    let raw: string
    try {
      raw = await readFile(`${folder}/intent.json`, 'utf8')
    } catch (error) {
      if (!isMissing(error)) throw error
      // Capture starts only after this intent is durable; this is allocation debris.
      await rm(folder, { recursive: true, force: true })
      await syncPath(directory)
      continue
    }
    {
      const intent = JSON.parse(raw) as {
        path: string
        effect?: string
        to?: string
        receipt?: string
        sentinel?: { dev: number; ino: number }
        expected?: { size: number; mtime: number; sha: string } | null
        stageId?: string
      }
      const target = await containedIn(root, intent.path),
        victim = await containedIn(root, `.abele-sync/${location}/${id}/victim`)
      check()
      let installed = false
      const destination =
        intent.effect === 'move' && intent.to ? await containedIn(root, intent.to) : target
      try {
        const dataPath =
          intent.effect === 'move'
            ? victim
            : intent.stageId
              ? await containedIn(root, `.abele-sync/stages/${valid(intent.stageId)}/data`)
              : `${folder}/data`
        const [data, named] = await Promise.all([lstat(dataPath), lstat(destination)])
        installed = data.isFile() && data.dev === named.dev && data.ino === named.ino
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      // An installed inode proves publication, not that its public name survived
      // fsync. Make that name durable before retiring any displaced bytes/evidence.
      if (installed) await syncParents(destination, root)
      let hasVictim = false
      let info
      try {
        info = await lstat(victim)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      if (info !== undefined) {
        hasVictim = intent.sentinel?.dev !== info.dev || intent.sentinel?.ino !== info.ino
        if (!hasVictim) {
          await unlink(victim)
        } else if (intent.effect === 'move' && installed) {
          // The destination owns this inode now, including any in-place local edit.
          // Drop only the private alias after the destination durability barrier.
          await unlink(victim)
          await syncParents(victim, root)
        } else if (
          info.isFile() &&
          (complete || installed) &&
          intent.expected &&
          (await matchesVictim(victim, intent.expected))
        ) {
          if (retain)
            await retain(
              `.abele-sync/${location}/${id}/victim`,
              intent.path,
              intent.expected,
              intent.receipt
                ? { kind: 'installation', id: intent.receipt }
                : intent.stageId
                  ? { kind: 'stage', id: intent.stageId }
                  : undefined
            )
          else await unlink(victim)
          await syncParents(victim, root)
        } else {
          await restoring(folder, root)
          // A restore-intent marker does not prove a public link ever existed.
          // Exclusive restoration retries the original name; occupied names are
          // preserved by restoreVictim's inode/conflict-copy handling.
          await restoreVictim(root, intent.path, victim, id)
        }
      }
      // Preserve only a receipt for a proven installed object, never a victim.
      if (installed && intent.effect === 'write' && intent.receipt) {
        const receipt = await containedIn(root, `.abele-sync/installations/${id}`)
        await mkdir(dirname(receipt), { recursive: true })
        await rename(folder, receipt)
        await syncParents([folder, receipt], root)
      } else {
        await rm(folder, { recursive: true, force: true })
        await syncPath(directory)
      }
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
    let data = await containedIn(root, `.abele-sync/installations/${valid(receipt)}/data`)
    try {
      await lstat(data)
    } catch (error) {
      if (!isMissing(error)) throw error
      data = await containedIn(root, `.abele-sync/conditional/${valid(receipt)}/data`)
    }
    const target = await containedIn(root, path)
    const [a, b] = await Promise.all([lstat(data), lstat(target)])
    const installed =
      a.isFile() &&
      b.isFile() &&
      a.ino === b.ino &&
      a.dev === b.dev &&
      (await fingerprint(target, b.size)) === sha
    if (installed) await syncParents(target, root)
    return installed
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function discardInstallation(
  root: string,
  receipt: string,
  check: () => void
): Promise<void> {
  const path = await containedIn(root, `.abele-sync/installations/${valid(receipt)}`)
  check()
  await rm(path, { recursive: true, force: true })
  try {
    await syncPath(dirname(path))
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}
