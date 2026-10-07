import { describe, expect, it } from 'vitest'
import { IgnoreRules } from '../../src/index.js'

function rules(...lines: string[]): IgnoreRules {
  return IgnoreRules.parse(lines.join('\n'))
}

describe('IgnoreRules.parse', () => {
  it('ignores nothing when there are no rules', () => {
    const r = IgnoreRules.parse('')
    expect(r.ignores('a.md')).toBe(false)
    expect(r.ignores('a/b.tmp')).toBe(false)
  })

  it('skips blank lines and comments', () => {
    const r = rules('', '   ', '# *.md', '#nor this one', '*.tmp')
    expect(r.ignores('a.md')).toBe(false)
    expect(r.ignores('a.tmp')).toBe(true)
  })

  it('takes an escaped hash as a literal name', () => {
    const r = rules('\\#draft.md')
    expect(r.ignores('#draft.md')).toBe(true)
    expect(r.ignores('draft.md')).toBe(false)
  })

  it('trims trailing spaces unless they are escaped', () => {
    expect(rules('*.tmp   ').ignores('a.tmp')).toBe(true)
    const escaped = rules('secret\\ ')
    expect(escaped.ignores('secret ')).toBe(true)
    expect(escaped.ignores('secret')).toBe(false)
  })

  it('tolerates CRLF line endings', () => {
    const r = IgnoreRules.parse('*.tmp\r\n!keep.tmp\r\n')
    expect(r.ignores('a.tmp')).toBe(true)
    expect(r.ignores('keep.tmp')).toBe(false)
  })
})

describe('IgnoreRules matching', () => {
  it('matches a slashless pattern at any depth', () => {
    const r = rules('*.tmp')
    expect(r.ignores('a.tmp')).toBe(true)
    expect(r.ignores('a/b/c.tmp')).toBe(true)
    expect(r.ignores('a/b/c.md')).toBe(false)
    expect(r.ignores('tmp')).toBe(false)
  })

  it('anchors a pattern with a leading slash to the root', () => {
    const r = rules('/root-only.md')
    expect(r.ignores('root-only.md')).toBe(true)
    expect(r.ignores('sub/root-only.md')).toBe(false)
  })

  it('anchors a pattern that carries an inner slash', () => {
    const r = rules('a/b.md')
    expect(r.ignores('a/b.md')).toBe(true)
    expect(r.ignores('x/a/b.md')).toBe(false)
  })

  it('matches a directory and everything under it', () => {
    const r = rules('logs')
    expect(r.ignores('logs')).toBe(true)
    expect(r.ignores('logs/a.md')).toBe(true)
    expect(r.ignores('a/logs/b.md')).toBe(true)
    expect(r.ignores('logsome.md')).toBe(false)
  })

  it('matches directories only when the pattern ends in a slash', () => {
    const r = rules('build/')
    expect(r.ignores('build/x.md')).toBe(true)
    expect(r.ignores('a/build/x.md')).toBe(true)
    expect(r.ignores('build')).toBe(false)
    expect(r.ignores('builds/x.md')).toBe(false)
  })

  it('anchors a directory pattern with a leading slash', () => {
    const r = rules('/build/')
    expect(r.ignores('build/x.md')).toBe(true)
    expect(r.ignores('a/build/x.md')).toBe(false)
  })

  it('keeps a star inside one segment', () => {
    const r = rules('a/*.md')
    expect(r.ignores('a/x.md')).toBe(true)
    expect(r.ignores('a/b/x.md')).toBe(false)
  })

  it('crosses directories on **', () => {
    const r = rules('**/cache/**')
    expect(r.ignores('cache/a.md')).toBe(true)
    expect(r.ignores('a/b/cache/c/d.md')).toBe(true)
    expect(r.ignores('cache')).toBe(false)
    expect(r.ignores('mycache/a.md')).toBe(false)
  })

  it('matches zero or more directories for an inner **', () => {
    const r = rules('a/**/b')
    expect(r.ignores('a/b')).toBe(true)
    expect(r.ignores('a/x/b')).toBe(true)
    expect(r.ignores('a/x/y/b')).toBe(true)
    expect(r.ignores('a/x/y')).toBe(false)
    expect(r.ignores('x/a/b')).toBe(false)
  })

  it('matches one character for ?', () => {
    const r = rules('note?.md')
    expect(r.ignores('note1.md')).toBe(true)
    expect(r.ignores('note.md')).toBe(false)
    expect(r.ignores('note12.md')).toBe(false)
    expect(r.ignores('note/.md')).toBe(false)
  })

  it('matches a character class', () => {
    const r = rules('file[abc].md')
    expect(r.ignores('filea.md')).toBe(true)
    expect(r.ignores('filec.md')).toBe(true)
    expect(r.ignores('filed.md')).toBe(false)
  })

  it('matches a class range and a negated class', () => {
    expect(rules('v[0-9].md').ignores('v7.md')).toBe(true)
    expect(rules('v[0-9].md').ignores('vx.md')).toBe(false)
    expect(rules('v[!0-9].md').ignores('vx.md')).toBe(true)
    expect(rules('v[!0-9].md').ignores('v7.md')).toBe(false)
  })

  it('treats a dot as a literal, not as any character', () => {
    const r = rules('a.md')
    expect(r.ignores('a.md')).toBe(true)
    expect(r.ignores('axmd')).toBe(false)
  })

  it('takes every regex metacharacter as a literal', () => {
    for (const [pattern, hit, miss] of [
      ['a+b.md', 'a+b.md', 'aab.md'],
      ['a(b).md', 'a(b).md', 'ab.md'],
      ['a{b}.md', 'a{b}.md', 'ab.md'],
      ['a$b.md', 'a$b.md', 'ab.md'],
      ['a|b.md', 'a|b.md', 'a.md'],
      ['a^b.md', 'a^b.md', 'ab.md'],
    ] as const) {
      const r = rules(pattern)
      expect(r.ignores(hit)).toBe(true)
      expect(r.ignores(miss)).toBe(false)
    }
  })

  it('takes an escaped star as a literal star', () => {
    const r = rules('star\\*.md')
    expect(r.ignores('star*.md')).toBe(true)
    expect(r.ignores('starry.md')).toBe(false)
  })
})

describe('IgnoreRules negation', () => {
  it('lets the last matching rule win', () => {
    const r = rules('*.tmp', '!keep.tmp')
    expect(r.ignores('a.tmp')).toBe(true)
    expect(r.ignores('keep.tmp')).toBe(false)
    expect(r.ignores('sub/keep.tmp')).toBe(false)
  })

  it('re-excludes when the negation comes first', () => {
    const r = rules('!keep.tmp', '*.tmp')
    expect(r.ignores('keep.tmp')).toBe(true)
  })

  it('takes a negation of a folder pattern', () => {
    const r = rules('build/', '!build/keep.md')
    expect(r.ignores('build/x.md')).toBe(true)
    expect(r.ignores('build/keep.md')).toBe(false)
  })

  it('takes an escaped bang as a literal name', () => {
    const r = rules('\\!odd.md')
    expect(r.ignores('!odd.md')).toBe(true)
    expect(r.ignores('odd.md')).toBe(false)
  })
})
