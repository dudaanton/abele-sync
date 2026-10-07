import { parse } from 'yaml'

/** A leading `---` block closed by a `---` line; the body may follow or the note may end there. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const MAX_BLOCK_BYTES = 64 * 1024
const MAX_ALIAS_COUNT = 100

/** A YAML map, or nothing at all — a blank or comment-only block is a note with no properties. */
const isMapOrEmpty = (value: unknown): boolean =>
  value === null || (typeof value === 'object' && !Array.isArray(value))

/**
 * True when the note has no leading frontmatter block, or the block is empty or parses to a
 * YAML map. False for a block over 64 KB, broken YAML, a scalar or a list — and for an alias
 * bomb, which the parser refuses once the alias budget is spent, before expanding it.
 */
export function frontmatterIsValid(text: string): boolean {
  const match = FRONTMATTER.exec(text)
  if (!match) return true
  const block = match[1] ?? ''
  if (Buffer.byteLength(block, 'utf8') > MAX_BLOCK_BYTES) return false
  try {
    // 'error' keeps parse() throwing on errors but stops it printing warnings to the console.
    return isMapOrEmpty(parse(block, { maxAliasCount: MAX_ALIAS_COUNT, logLevel: 'error' }))
  } catch {
    return false
  }
}
