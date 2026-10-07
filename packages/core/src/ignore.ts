/**
 * A gitignore matcher in plain TypeScript.
 *
 * Core carries no dependencies and no Node built-ins, so the vault's `.abele-sync-ignore`
 * file is parsed here rather than through the `ignore` package. The subset is gitignore's:
 * comments, negation, a directory suffix, anchors, `**`, `*`, `?` and character classes.
 *
 * One deliberate departure from git: a negation re-includes a file even when a parent
 * directory was excluded. The engine matches file paths one at a time and never walks the
 * tree by directory, so `build/` plus `!build/keep.md` keeps that one file.
 */

interface Rule {
  /** The compiled pattern, tested against a whole wire path. */
  re: RegExp
  /** A `!` rule, which re-includes what an earlier rule excluded. */
  negated: boolean
}

/** Escapes a character that means something to the regex engine. */
function literal(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/**
 * Drops the trailing spaces git drops: every run of spaces at the end of the line, unless
 * the space is escaped by an odd number of backslashes.
 */
function trimTrailingSpaces(line: string): string {
  let end = line.length
  while (end > 0 && line[end - 1] === ' ') {
    let backslashes = 0
    let i = end - 2
    while (i >= 0 && line[i] === '\\') {
      backslashes++
      i--
    }
    if (backslashes % 2 === 1) break
    end--
  }
  return line.slice(0, end)
}

/** Reads a `[…]` class, returning its regex and the index just past the `]`. */
function readClass(seg: string, start: number): { source: string; next: number } | null {
  let i = start + 1
  let negated = false
  if (seg[i] === '!' || seg[i] === '^') {
    negated = true
    i++
  }
  let body = ''
  // A `]` straight after the opener is a literal member, as in POSIX classes.
  if (seg[i] === ']') {
    body += '\\]'
    i++
  }
  while (i < seg.length && seg[i] !== ']') {
    const ch = seg[i]!
    if (ch === '\\' && i + 1 < seg.length) {
      body += `\\${seg[i + 1]!}`
      i += 2
      continue
    }
    body += ch === '[' || ch === '^' || ch === '\\' ? `\\${ch}` : ch
    i++
  }
  if (i >= seg.length) return null // unterminated: the `[` was a literal after all
  return { source: `[${negated ? '^' : ''}${body}]`, next: i + 1 }
}

/** Compiles one path segment, where neither `*` nor `?` may cross a slash. */
function segmentSource(seg: string): string {
  let out = ''
  let i = 0
  while (i < seg.length) {
    const ch = seg[i]!
    if (ch === '\\' && i + 1 < seg.length) {
      out += literal(seg[i + 1]!)
      i += 2
      continue
    }
    if (ch === '*') {
      // Consecutive stars inside a segment are one star, as git has it.
      while (seg[i] === '*') i++
      out += '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i++
      continue
    }
    if (ch === '[') {
      const cls = readClass(seg, i)
      if (cls) {
        out += cls.source
        i = cls.next
        continue
      }
    }
    out += literal(ch)
    i++
  }
  return out
}

/** Compiles a whole pattern body — the line with its `!`, anchor and directory slash removed. */
function bodySource(pattern: string): string {
  const segments = pattern.split('/')
  let out = ''
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const last = i === segments.length - 1
    if (seg === '**') {
      // A trailing `**` is everything below; an inner one is any run of directories,
      // including none, and it swallows the slash that follows it.
      out += last ? '.*' : '(?:[^/]*/)*'
      continue
    }
    out += segmentSource(seg)
    if (!last) out += '/'
  }
  return out
}

/** Turns one non-blank, non-comment line into a rule, or null when it says nothing. */
function compile(line: string): Rule | null {
  let pattern = line
  let negated = false
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  let dirOnly = false
  if (pattern.endsWith('/')) {
    dirOnly = true
    pattern = pattern.slice(0, -1)
  }
  // A slash anywhere but the (already stripped) end anchors the pattern to the vault root.
  const anchored = pattern.includes('/')
  if (pattern.startsWith('/')) pattern = pattern.slice(1)
  if (pattern === '') return null
  const prefix = anchored ? '^' : '^(?:.*/)?'
  // A directory pattern needs something below it; any other pattern matches the path
  // itself or, when it named a folder, everything under it.
  const suffix = dirOnly ? '/.+$' : '(?:/.*)?$'
  return { re: new RegExp(prefix + bodySource(pattern) + suffix), negated }
}

/**
 * Anything that can say a wire path is not this device's to sync right now.
 *
 * The vault's ignore file is one; the daemon composes another over it for files that are
 * still being written, so the engine takes both through the one option.
 */
export interface PathMatcher {
  ignores(wirePath: string): boolean
}

/** The rules of one ignore file, in the order they were written. */
export class IgnoreRules implements PathMatcher {
  private constructor(private readonly rules: readonly Rule[]) {}

  /** Parses the text of a `.abele-sync-ignore` file. CRLF and LF both split lines. */
  static parse(text: string): IgnoreRules {
    const rules: Rule[] = []
    for (const raw of text.split(/\r?\n/)) {
      const line = trimTrailingSpaces(raw.replace(/\r+$/, ''))
      if (line === '' || line.startsWith('#')) continue
      const rule = compile(line)
      if (rule) rules.push(rule)
    }
    return new IgnoreRules(rules)
  }

  /** True when the wire path is ignored. The last rule that matches decides. */
  ignores(wirePath: string): boolean {
    let ignored = false
    for (const rule of this.rules) {
      // A rule can only flip the verdict: skip the ones that would leave it where it is.
      if (rule.negated !== ignored) continue
      if (rule.re.test(wirePath)) ignored = !rule.negated
    }
    return ignored
  }
}
