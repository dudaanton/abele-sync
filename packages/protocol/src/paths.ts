import { AbeleError } from './errors.js'

/** Every kind of file a vault holds. Schemas derive their enum from this tuple. */
export const FILE_KINDS = ['note', 'canvas', 'script', 'settings', 'attachment'] as const

export type FileKind = (typeof FILE_KINDS)[number]

/** Characters no vault path may carry, on any platform we sync to. */
const FORBIDDEN = /[\\:*?"<>|\u0000-\u001f\u007f]/
/** Windows device names, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

const MAX_RAW_BYTES = 4096
const MAX_PATH_BYTES = 1024
const MAX_SEGMENT_BYTES = 255
const MAX_NAME_CANDIDATES = 10_000

/** UTF-8 length through the web platform: this package runs wherever core does, Obsidian included. */
const encoder = new TextEncoder()
const utf8Length = (s: string): number => encoder.encode(s).length

/** Cut only at code-point boundaries, leaving room for a generated suffix. */
export function fitGeneratedName(
  folder: string,
  stem: string,
  ext: string,
  suffix: string
): string {
  // When a valid parent already fills the path limit, no suffixed file can live beside it.
  // Keep the copy reachable by every client at the vault root instead of publishing a path
  // none can read. The caller's collision check still runs on this final name.
  const first = Array.from(stem)[0] ?? 'x'
  const enough = (parent: string): number =>
    Math.min(MAX_SEGMENT_BYTES, MAX_PATH_BYTES - utf8Length(parent)) - utf8Length(suffix)
  // A usable basename needs its first code point and its complete extension; a truncated
  // dot or an empty multibyte stem would be rejected by every client.
  const parent = enough(folder) < utf8Length(first) + utf8Length(ext) ? '' : folder
  const room = enough(parent)
  if (room <= 0) throw new AbeleError('invalid_path', 'no room for generated name')
  const cut = (text: string, bytes: number): string => {
    let result = ''
    for (const char of text) {
      if (utf8Length(result + char) > bytes) break
      result += char
    }
    return result
  }
  let ending = cut(ext, Math.max(0, room - utf8Length(first)))
  if (ending === '.') ending = ''
  const name = `${cut(stem, room - utf8Length(ending))}${suffix}${ending}`.normalize('NFC')
  const path = parent + name
  validatePath(path)
  return path
}

/**
 * NFC, forward slashes, no leading `./` or `/`, no trailing `/`.
 *
 * The result is not guaranteed to be valid: `'/./a'` normalises to `'./a'`, which
 * `validatePath` rejects. Callers always run `validatePath` on the result.
 */
export function normalisePath(raw: string): string {
  if (utf8Length(raw) > MAX_RAW_BYTES) {
    throw new AbeleError('invalid_path', 'too long', { path: '<omitted>', reason: 'too long' })
  }
  let p = raw
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
  while (p.startsWith('/')) p = p.slice(1)
  while (p.endsWith('/')) p = p.slice(0, -1)
  return p
}

/** Throws `AbeleError('invalid_path', ...)` unless the path is one we accept on the wire. */
export function validatePath(path: string): void {
  const fail = (reason: string): never => {
    throw new AbeleError('invalid_path', `${reason}: ${path}`, { path, reason })
  }
  if (path.length === 0) return fail('empty')
  if (utf8Length(path) > MAX_PATH_BYTES) return fail('too long')
  if (path.startsWith('/')) return fail('absolute')
  if (path !== path.normalize('NFC')) return fail('not nfc')
  if (FORBIDDEN.test(path)) return fail('forbidden character')
  for (const [index, seg] of path.split('/').entries()) {
    if (seg.length === 0) return fail('empty segment')
    if (seg === '.' || seg === '..') return fail('dot segment')
    if (seg !== seg.trim()) return fail('leading or trailing space')
    if (seg.startsWith('.') && !(index === 0 && (seg === '.obsidian' || seg === '.trash')))
      return fail('leading dot')
    if (seg.endsWith('.')) return fail('trailing dot')
    if (RESERVED.test(seg)) return fail('reserved name')
    if (utf8Length(seg) > MAX_SEGMENT_BYTES) return fail('segment too long')
  }
}

/** The case-insensitive key a path is stored under: the path_ci column. */
export function caseKey(path: string): string {
  return path.normalize('NFC').toLowerCase()
}

/** Splits a path into folder, file name, stem and extension. A leading dot is not an extension. */
export function splitPath(path: string): {
  folder: string
  name: string
  stem: string
  ext: string
} {
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const name = slash === -1 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { folder, name, stem: name, ext: '' }
  return { folder, name, stem: name.slice(0, dot), ext: name.slice(dot) }
}

/** The path itself when free, else Obsidian's `name 1.ext`, `name 2.ext`, and so on. */
export function nextFreeName(path: string, taken: (caseKey: string) => boolean): string {
  if (!taken(caseKey(path))) return path
  const { folder, stem, ext } = splitPath(path)
  const prefix = folder === '' ? '' : `${folder}/`
  for (let n = 1; n <= MAX_NAME_CANDIDATES; n++) {
    const candidate = fitGeneratedName(prefix, stem, ext, ` ${n}`)
    if (!taken(caseKey(candidate))) return candidate
  }
  throw new AbeleError('path_taken', `no free name after ${MAX_NAME_CANDIDATES} tries: ${path}`, {
    path,
  })
}

/** Strips trailing slashes without scanning the string more than once per slash. */
function trimTrailingSlashes(folder: string): string {
  let f = folder
  while (f.endsWith('/')) f = f.slice(0, -1)
  return f
}

/** What a path holds, by folder first and extension second. */
export function kindOf(path: string, scriptsFolder: string): FileKind {
  if (path.startsWith('.obsidian/')) return 'settings'
  const ext = splitPath(path).ext.toLowerCase()
  if (ext === '.md') return 'note'
  if (ext === '.canvas') return 'canvas'
  // An empty scripts folder means the vault has none, so nothing is ever a script.
  const scripts = trimTrailingSlashes(scriptsFolder)
  if (ext === '.js' && scripts !== '' && caseKey(path).startsWith(caseKey(scripts) + '/'))
    return 'script'
  return 'attachment'
}
