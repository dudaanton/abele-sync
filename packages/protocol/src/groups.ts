import { CST, Parser, isMap, isScalar, isSeq, parseDocument } from 'yaml'
/** Bounded, portable frontmatter extraction shared by server indexing and local eligibility.
 * Body links never become membership. Invalid/over-budget YAML grants no new membership.
 */
export type GroupFrontmatter =
  { status: 'valid'; groups: string[] } | { status: 'invalid' | 'limited'; groups: [] }
const MAX_BYTES = 65536,
  MAX_DEPTH = 32,
  MAX_TOKENS = 256
const tags = new Set(
  ['str', 'seq', 'map', 'bool', 'int', 'float', 'null'].flatMap((tag) => [
    `!!${tag}`,
    `!<tag:yaml.org,2002:${tag}>`,
  ])
)
function budget(source: string): 'invalid' | 'limited' | null {
  for (const root of new Parser().parse(source)) {
    const stack: Array<{ token: CST.Token; depth: number }> = [{ token: root, depth: 0 }]
    const push = (token: CST.Token | null | undefined, depth: number) => {
        if (token) stack.push({ token, depth })
      },
      list = (tokens: CST.Token[] | undefined, depth: number) => {
        if (tokens) for (const token of tokens) push(token, depth)
      }
    while (stack.length) {
      const { token, depth } = stack.pop()!
      if (token.type === 'alias' || token.type === 'error' || token.type === 'directive')
        return 'invalid'
      if (token.type === 'tag' && !tags.has(token.source)) return 'invalid'
      if (CST.isCollection(token)) {
        const level = depth + 1
        if (level > MAX_DEPTH) return 'limited'
        if (token.type === 'flow-collection') {
          push(token.start, level)
          list(token.end, level)
        }
        for (const item of token.items) {
          const implicit =
            token.type === 'flow-collection' &&
            token.start.type === 'flow-seq-start' &&
            (item.key !== undefined || item.sep?.some((part) => part.type === 'map-value-ind'))
          const next = level + (implicit ? 1 : 0)
          if (next > MAX_DEPTH) return 'limited'
          list(item.start, next)
          list(item.sep, next)
          push(item.key, next)
          push(item.value, next)
        }
      } else if (token.type === 'document') {
        list(token.start, depth)
        push(token.value, depth)
        list(token.end, depth)
      } else if (token.type === 'block-scalar') list(token.props, depth)
      else if ('end' in token) list(token.end, depth)
    }
  }
  return null
}
export function parseGroupFrontmatter(text: string): GroupFrontmatter {
  const start = text.startsWith('\uFEFF') ? 1 : 0,
    opening = text.startsWith('---\r\n', start) ? 5 : text.startsWith('---\n', start) ? 4 : 0
  if (!opening)
    return text.slice(start) === '---'
      ? { status: 'invalid', groups: [] }
      : { status: 'valid', groups: [] }
  const first = start + opening,
    prefix = text.slice(0, first + MAX_BYTES + 8)
  let cursor = first,
    source: string | undefined
  while (cursor <= prefix.length) {
    const newline = prefix.indexOf('\n', cursor),
      end = newline === -1 ? prefix.length : newline,
      line = prefix.slice(cursor, end).replace(/\r$/, '')
    if (line === '---') {
      source = prefix.slice(first, cursor)
      break
    }
    if (end - first > MAX_BYTES) return { status: 'limited', groups: [] }
    if (newline === -1) break
    cursor = newline + 1
  }
  if (source === undefined)
    return { status: text.length > prefix.length ? 'limited' : 'invalid', groups: [] }
  if (new TextEncoder().encode(source).length > MAX_BYTES) return { status: 'limited', groups: [] }
  try {
    const status = budget(source)
    if (status) return { status, groups: [] }
    const document = parseDocument(source, { schema: 'core', uniqueKeys: true, logLevel: 'silent' })
    if (document.errors.length || document.warnings.length) return { status: 'invalid', groups: [] }
    if (document.contents === null) return { status: 'valid', groups: [] }
    if (!isMap(document.contents)) return { status: 'invalid', groups: [] }
    const groups = document.contents.get('groups', true)
    if (groups === undefined || (isScalar(groups) && groups.value === null))
      return { status: 'valid', groups: [] }
    if (!isSeq(groups)) return { status: 'invalid', groups: [] }
    if (groups.items.length > MAX_TOKENS) return { status: 'limited', groups: [] }
    const result: string[] = []
    for (const item of groups.items) {
      if (!isScalar(item) || typeof item.value !== 'string')
        return { status: 'invalid', groups: [] }
      if (item.value.length > 1024) return { status: 'limited', groups: [] }
      result.push(item.value)
    }
    return { status: 'valid', groups: result }
  } catch {
    return { status: 'invalid', groups: [] }
  }
}

/** Canonical wiki link spelling, not a path grant. Explicit relative paths are relative
 * to the member note; basename/suffix candidates must resolve uniquely. */
export function groupLinkKey(link: string, sourcePath: string): string | null {
  const match = /^\[\[([^\]]+)\]\]$/.exec(link.trim())
  if (!match) return null
  let value = match[1]!.split('|')[0]!.split('#')[0]!.trim().replace(/\\/g, '/')
  if (!value || value.includes(':')) return null
  if (value.startsWith('./') || value.startsWith('../')) {
    const parts = sourcePath.split('/').slice(0, -1)
    for (const part of value.split('/')) {
      if (part === '.' || !part) continue
      if (part === '..') {
        if (!parts.length) return null
        parts.pop()
      } else parts.push(part)
    }
    value = parts.join('/')
  }
  value = value.replace(/^\//, '').replace(/\.md$/i, '').normalize('NFC').toLowerCase()
  if (value.split('/').some((p) => !p || p === '.' || p === '..')) return null
  return value || null
}
/** Exact vault paths take precedence; fallback is a unique path suffix, never first match. */
export function resolveGroupLink<T extends { id: string; path: string }>(
  key: string,
  notes: readonly T[]
): string | null {
  const normalize = (path: string) => path.replace(/\.md$/i, '').normalize('NFC').toLowerCase()
  const exact = notes.filter((n) => normalize(n.path) === key)
  if (exact.length) return exact.length === 1 ? exact[0]!.id : null
  const suffix = notes.filter((n) => normalize(n.path).endsWith('/' + key))
  return suffix.length === 1 ? suffix[0]!.id : null
}
