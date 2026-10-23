import { ScanWork } from './scanWork.js'
import { transact } from './stateTransaction.js'
import { AbeleError, caseKey, validatePath } from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { StateStore } from './state.js'
import { z } from 'zod'

const CollisionSchema = z.array(
  z.tuple([z.string(), z.object({ winner: z.string(), losers: z.array(z.string()) }).strict()])
)
const DirectoryHoldSchema = z.array(
  z
    .object({ path: z.string(), winner: z.string().nullable(), aliases: z.array(z.string()) })
    .strict()
)
export async function rememberedCollisions(state: StateStore) {
  return new Map(
    CollisionSchema.parse(JSON.parse((await state.getMeta?.('normalization-collisions')) ?? '[]'))
  )
}

export async function resolveLocalFile(
  fs: FileSystem,
  state: StateStore,
  path: string,
  preferred?: string,
  snapshot?: LocalPaths
): Promise<string> {
  const inventory = snapshot ?? (await LocalPaths.forFile(fs, path, state))
  const target = inventory.resolve(path, 'file', preferred)
  const known = (await rememberedCollisions(state)).get(path)
  if (known?.losers.includes(target) && target !== known.winner)
    throw new AbeleError(
      'path_taken',
      `normalization collision: ${JSON.stringify(target)} is blocked by ${JSON.stringify(known.winner)}`
    )
  return target
}

/** Local enumeration is already relative and slash separated. Never repair its structure. */
export function wirePath(local: string): string {
  const path = local.normalize('NFC')
  validatePath(path)
  return path
}

/** Refresh only local keys; pending pull provenance remains immutable. */
export async function refreshLocalPaths(fs: FileSystem, state: StateStore): Promise<void> {
  const inventory = await LocalPaths.read(fs, state)
  await inventory.rememberDirectories(state)
  const known = await rememberedCollisions(state)
  for await (const entry of state.all()) {
    if (await state.getMeta?.(`pull-write:${entry.fileId}`)) continue
    if (inventory.blocked(entry.wirePath)) continue
    let path: string
    try {
      path = inventory.resolve(entry.wirePath, 'file', entry.path)
    } catch {
      continue
    }
    if (path === entry.path || (await fs.stat(path)) === null) continue
    if (known.get(entry.wirePath)?.losers.includes(path)) continue
    const occupant = await state.get(path)
    if (occupant && occupant.fileId !== entry.fileId) continue
    await transact(state, async (tx) => {
      await tx.delete(entry.path)
      await tx.put({ ...entry, path })
    })
  }
}

interface Candidate {
  path: string
  kind: 'file' | 'directory'
  identity?: string
}

// ASCII canonical equivalents: Kelvin sign, Greek question mark and Greek varia.
const mayHaveAliases = (path: string): boolean => /[^\x00-\x7f]|[K;`]/.test(path)

/** Retains every physical spelling, including aliases hidden by insensitive hosts. */
export class LocalPaths {
  private readonly entries = new Map<string, Candidate[]>()
  private readonly heldDirectories: Array<{ path: string; wirePath: string; with: string }> = []
  /** Cache portable preflight enumeration for one pull, never the final write recheck. */
  static filePass(fs: FileSystem, state: StateStore): (path: string) => Promise<LocalPaths> {
    let inventory: Promise<LocalPaths> | undefined
    return (path) => {
      const key = wirePath(path)
      if (fs.listChildren || !mayHaveAliases(key)) return LocalPaths.forFile(fs, key, state)
      return (inventory ??= LocalPaths.read(fs, state))
    }
  }
  private add(entry: Candidate) {
    const key = entry.path.normalize('NFC')
    const candidates = this.entries.get(key) ?? []
    const existing = candidates.find((c) => c.path === entry.path && c.kind === entry.kind)
    if (existing) {
      if (existing.identity && entry.identity && existing.identity !== entry.identity)
        throw new AbeleError(
          'path_taken',
          `directory identity changed during inventory: ${entry.path}`
        )
      existing.identity ??= entry.identity
    } else candidates.push(entry)
    this.entries.set(key, candidates)
  }
  /** File spelling needs raw enumeration only when a canonical alias is possible. */
  static async forFile(fs: FileSystem, path: string, state?: StateStore): Promise<LocalPaths> {
    const key = wirePath(path)
    // ASCII has no alternate canonical spellings except K, ; and `.
    // No raw inventory can change the spelling otherwise.
    // Keep loading persisted directory holds even on this fast path.
    if (!mayHaveAliases(key)) {
      const result = new LocalPaths()
      if (state) await result.loadDirectoryHolds(state)
      return result
    }
    return LocalPaths.forPath(fs, key, state)
  }
  /** Recheck only ancestors on capable hosts; portable adapters retain the safe fallback. */
  static async forPath(fs: FileSystem, path: string, state?: StateStore): Promise<LocalPaths> {
    if (!fs.listChildren) return LocalPaths.read(fs, state)
    const result = new LocalPaths()
    const segments = wirePath(path).split('/')
    let parent = ''
    for (let n = 0; n < segments.length; n++) {
      for (const child of await fs.listChildren(parent)) result.add(child)
      const prefix = segments.slice(0, n + 1).join('/')
      const matches = result.entries.get(prefix) ?? []
      if (matches.length !== 1 || matches[0]!.kind !== 'directory') break
      parent = matches[0]!.path
    }
    if (state) await result.loadDirectoryHolds(state)
    return result
  }
  *filePaths(): Iterable<string> {
    for (const [path, candidates] of this.entries)
      if (candidates.some((entry) => entry.kind === 'file')) yield path
  }
  directory(path: string): Candidate | undefined {
    return this.entries
      .get(path.normalize('NFC'))
      ?.find((c) => c.path === path && c.kind === 'directory')
  }
  directoryCaseAlias(path: string, identity: string): Candidate | undefined {
    const matches = [...this.entries.values()]
      .flat()
      .filter(
        (entry) =>
          entry.kind === 'directory' &&
          entry.identity === identity &&
          caseKey(entry.path) === caseKey(path)
      )
    return matches.length === 1 ? matches[0] : undefined
  }
  static async read(fs: FileSystem, state?: StateStore): Promise<LocalPaths> {
    const result = new LocalPaths()
    const work = new ScanWork()
    const parents = (path: string) => {
      const segments = path.split('/')
      for (let n = 1; n < segments.length; n++)
        result.add({ path: segments.slice(0, n).join('/'), kind: 'directory' })
    }
    if (fs.listDirectories)
      for await (const dir of fs.listDirectories()) {
        result.add({ ...dir, kind: 'directory' })
        parents(dir.path)
        await work.step()
      }
    for await (const file of fs.list()) {
      result.add({ path: file.path, kind: 'file' })
      parents(file.path)
      await work.step()
    }
    if (state) await result.loadDirectoryHolds(state)
    return result
  }
  private async loadDirectoryHolds(state: StateStore) {
    const holds = DirectoryHoldSchema.parse(
      JSON.parse((await state.getMeta?.('normalization-directory-collisions')) ?? '[]')
    )
    for (const hold of holds) {
      const candidates = this.entries.get(hold.path) ?? []
      if (hold.winner && !candidates.some((c) => c.path === hold.winner))
        for (const candidate of candidates)
          if (hold.aliases.includes(candidate.path))
            this.heldDirectories.push({
              path: candidate.path,
              wirePath: hold.path,
              with: hold.winner,
            })
    }
  }
  /** A tracked physical directory never yields its canonical subtree to a former twin. */
  async rememberDirectories(state: StateStore) {
    const previous = DirectoryHoldSchema.parse(
      JSON.parse((await state.getMeta?.('normalization-directory-collisions')) ?? '[]')
    )
    const holds = new Map(previous.map((hold) => [hold.path, hold]))
    const ledger = JSON.parse(
      (await state.getMeta?.('v2-directories')) ?? '{"directories":[]}'
    ) as { directories: Array<{ path: string; identity: string }> }
    for (const [path, candidates] of this.entries) {
      if (candidates.length < 2 || !candidates.some((c) => c.kind === 'directory')) continue
      const identity = ledger.directories.find((d) => d.path === path)?.identity
      const winner =
        candidates.find((c) => identity !== undefined && c.identity === identity)?.path ??
        holds.get(path)?.winner ??
        null
      holds.set(path, { path, winner, aliases: candidates.map((c) => c.path) })
    }
    for (const [path, hold] of holds) {
      const candidates = this.entries.get(path) ?? []
      if (candidates.length > 1) continue
      if (
        candidates.length === 0 ||
        !hold.winner ||
        candidates[0]!.path === hold.winner ||
        !hold.aliases.includes(candidates[0]!.path)
      )
        holds.delete(path)
    }
    await state.setMeta?.('normalization-directory-collisions', JSON.stringify([...holds.values()]))
  }
  /** Directory aliases (including file/directory aliases) protect the whole subtree. */
  directoryCollisions(): Array<{ path: string; wirePath: string; with: string }> {
    const result: Array<{ path: string; wirePath: string; with: string }> = [
      ...this.heldDirectories,
    ]
    for (const [key, candidates] of this.entries)
      if (candidates.length > 1 && candidates.some((c) => c.kind === 'directory'))
        for (const candidate of candidates)
          result.push({
            path: candidate.path,
            wirePath: key,
            with: candidates.find((c) => c !== candidate)!.path,
          })
    return result
  }
  blocked(path: string): boolean {
    path = path.normalize('NFC')
    if (
      this.heldDirectories.some(
        (held) => path === held.wirePath || path.startsWith(held.wirePath + '/')
      )
    )
      return true
    const parts = path.normalize('NFC').split('/')
    for (let n = 1; n <= parts.length; n++) {
      const candidates = this.entries.get(parts.slice(0, n).join('/')) ?? []
      if (candidates.length > 1 && candidates.some((c) => c.kind === 'directory')) return true
    }
    return false
  }
  resolve(path: string, kind: Candidate['kind'], preferred?: string): string {
    const key = wirePath(path)
    if (
      this.heldDirectories.some(
        (held) => key === held.wirePath || key.startsWith(held.wirePath + '/')
      )
    )
      throw new AbeleError('path_taken', `normalization collision: held directory subtree ${key}`)
    const segments = key.split('/')
    let local = ''
    for (let n = 1; n <= segments.length; n++) {
      const prefix = segments.slice(0, n).join('/')
      let candidates = this.entries.get(prefix) ?? []
      const expected = n === segments.length ? kind : 'directory'
      if (
        n === segments.length &&
        expected === 'file' &&
        preferred &&
        candidates.every((c) => c.kind === 'file')
      ) {
        const tracked = candidates.find((c) => c.path === preferred)
        if (tracked) candidates = [tracked]
      }
      if (candidates.length > 1 || candidates.some((c) => c.kind !== expected)) {
        const spellings = candidates.map(
          (c) =>
            `${JSON.stringify(c.path)} (${Array.from(c.path)
              .map((ch) => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase())
              .join(' ')})`
        )
        throw new AbeleError(
          'path_taken',
          `normalization collision: ${prefix}: ${spellings.join(', ')}`
        )
      }
      local = candidates[0]?.path ?? (local ? local + '/' : '') + segments[n - 1]!
    }
    return local
  }
}
