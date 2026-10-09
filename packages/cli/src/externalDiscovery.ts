import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { open, opendir, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ExternalStateError,
  IgnoreRules,
  isExcluded,
  isHidden,
  selectiveDefaults,
  type SelectiveSettings,
} from '@abele/sync-core'
import { stateFolder } from './config.js'

export const PROJECTION_SIZE_CAP = 16 * 1024
const INDEX_FILE = 'projection-index.json'
interface Entry {
  path: string
  size: number
  mtime: number
  marker: boolean
}
export interface ProjectionInventoryOptions {
  guard?: () => void
  selective?: SelectiveSettings
  /** Validated owned paths only; the lifecycle host checks their recorded digest. */
  ownedProjections?: ReadonlySet<string>
}
function held(path: string): never {
  const error = new ExternalStateError('recovery-required')
  error.message = `external files require recovery: unowned projection at ${path}; connection and recovery data were preserved`
  throw error
}
function entries(dir: string): Entry[] {
  try {
    const data = JSON.parse(readFileSync(join(stateFolder(dir), INDEX_FILE), 'utf8')) as {
      schema?: unknown
      entries?: unknown
    }
    if (data.schema !== 1 || !Array.isArray(data.entries)) return []
    return data.entries.filter(
      (row): row is Entry =>
        !!row &&
        typeof row === 'object' &&
        typeof row.path === 'string' &&
        typeof row.size === 'number' &&
        row.size >= 0 &&
        typeof row.mtime === 'number' &&
        typeof row.marker === 'boolean'
    )
  } catch {
    return []
  } // An index is an optimization, never permission to skip an invalid record.
}
export function assertIndexedProjectionSafety(dir: string, owned?: ReadonlySet<string>): void {
  const marker = entries(dir).find((entry) => entry.marker && !owned?.has(entry.path))
  if (marker) held(marker.path)
}
/** Root marker only; no adoption/schema/placement permission is inferred. */
function marker(bytes: Uint8Array): boolean {
  const text = new TextDecoder()
    .decode(bytes)
    .replace(/^\uFEFF/, '')
    .trimStart()
  if (!text.startsWith('{')) return false
  try {
    return (JSON.parse(text) as { format?: unknown }).format === 'abele.external'
  } catch {
    // As in the plugin, recognition decodes JSON spellings, not repaired schema.
    // A damaged/truncated marker in the bounded prefix can only establish a hold.
    const token = (start: number): { value: string | null; end: number } => {
      for (let end = start + 1; end < text.length; end++) {
        if (text[end] === '\\') {
          end++
          continue
        }
        if (text[end] !== '"') continue
        try {
          const value: unknown = end - start <= 86 ? JSON.parse(text.slice(start, end + 1)) : null
          return { value: typeof value === 'string' ? value : null, end: end + 1 }
        } catch {
          return { value: null, end: end + 1 }
        }
      }
      return { value: null, end: text.length }
    }
    for (let at = 0; at < text.length; at++) {
      if (text[at] !== '"') continue
      const key = token(at)
      at = key.end - 1
      let colon = key.end
      while (colon < text.length && /\s/.test(text[colon]!)) colon++
      if (text[colon] !== ':') continue
      let valueAt = colon + 1
      while (valueAt < text.length && /\s/.test(text[valueAt]!)) valueAt++
      if (text[valueAt] !== '"') continue
      const value = token(valueAt)
      if (
        (key.value === 'format' && (value.value === 'abele.external' || value.value === null)) ||
        (key.value === null && value.value === 'abele.external')
      )
        return true
      at = value.end - 1
    }
    return false
  }
}
function configuredSelective(dir: string): SelectiveSettings {
  try {
    const raw = JSON.parse(readFileSync(join(stateFolder(dir), 'config.json'), 'utf8')) as {
      selective?: SelectiveSettings
      connection?: { selective?: SelectiveSettings }
    }
    return { ...selectiveDefaults(), ...(raw.connection?.selective ?? raw.selective ?? {}) }
  } catch {
    return selectiveDefaults()
  }
}
/** One async, stat-first pass. Only the first capped prefix is ever inspected,
 * regardless of total file size; raced reads are capped too.
 * Path/size/mtime index entries are reusable only for that exact observed tuple.
 * Positive evidence survives edits/exclusion until explicit recovery resolves it.
 */
export async function inspectProjectionInventory(
  dir: string,
  options: ProjectionInventoryOptions = {}
): Promise<void> {
  const guard = options.guard ?? (() => {}),
    file = join(stateFolder(dir), INDEX_FILE)
  guard()
  assertIndexedProjectionSafety(dir, options.ownedProjections)
  const previous = new Map(entries(dir).map((entry) => [entry.path, entry])),
    next: Entry[] = []
  const selective = options.selective ?? configuredSelective(dir)
  let ignoreText = ''
  try {
    ignoreText = await readFile(join(dir, '.abele-sync-ignore'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const ignore = IgnoreRules.parse(ignoreText)
  let evidence: string | undefined,
    visited = 0
  const yieldTurn = async () => {
    if (++visited % 16 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    guard()
  }
  const walk = async (relative: string): Promise<void> => {
    guard()
    for await (const item of await opendir(join(dir, relative))) {
      await yieldTurn()
      if (item.isSymbolicLink() || (relative === '' && item.name === '.abele-sync')) continue
      const path = relative ? `${relative}/${item.name}` : item.name
      const control = path === '.abele-sync-ignore'
      if (
        !control &&
        (isHidden(path) ||
          ignore.ignores(path) ||
          selective.excludedFolders.some(
            (folder) => path === folder || path.startsWith(folder.replace(/\/$/, '') + '/')
          ))
      )
        continue
      if (item.isDirectory()) {
        await walk(path)
        continue
      }
      if (!item.isFile()) continue
      let before
      try {
        before = await lstat(join(dir, path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      guard()
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        (!control && isExcluded(path, before.size, selective, 'Scripts'))
      )
        continue
      const old = previous.get(path)
      if (old && old.size === before.size && old.mtime === before.mtimeMs) {
        next.push(old)
        continue
      }
      const handle = await open(join(dir, path), 'r')
      let found = false,
        stable = false
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) continue
        const bytes = new Uint8Array(PROJECTION_SIZE_CAP)
        guard()
        const read = await handle.read(bytes, 0, bytes.length, 0)
        guard()
        found = marker(bytes.subarray(0, read.bytesRead))
        const after = await lstat(join(dir, path))
        stable =
          after.isFile() &&
          after.dev === before.dev &&
          after.ino === before.ino &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs
      } finally {
        await handle.close()
      }
      if (found && !options.ownedProjections?.has(path)) evidence ??= path
      if (stable || found)
        next.push({ path, size: before.size, mtime: before.mtimeMs, marker: found })
    }
  }
  await walk('')
  guard()
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify({ schema: 1, entries: next }), { mode: 0o600, flag: 'wx' })
    guard()
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  if (evidence) held(evidence)
}
