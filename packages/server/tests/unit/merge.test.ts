import { describe, it, expect, vi } from 'vitest'
import DiffMatchPatch from 'diff-match-patch'
import { mergeText, conflictCopyName, frontmatterIsValid } from '../../src/merge/index.js'

/**
 * The characters one mergeText call hands to diff-match-patch, which is where a large conflict
 * costs time. The per-region caps and the per-document budget are what keep this small; a
 * wall-clock limit measured the same thing but failed on a busy machine.
 */
function charPassWork(run: () => void): { calls: number; chars: number } {
  const make = vi.spyOn(DiffMatchPatch.prototype, 'patch_make')
  const apply = vi.spyOn(DiffMatchPatch.prototype, 'patch_apply')
  try {
    run()
    const made = make.mock.calls.reduce(
      (sum, [a, b]) => sum + String(a).length + (typeof b === 'string' ? b.length : 0),
      0
    )
    const applied = apply.mock.calls.reduce((sum, [, text]) => sum + text.length, 0)
    return { calls: make.mock.calls.length, chars: made + applied }
  } finally {
    make.mockRestore()
    apply.mockRestore()
  }
}

describe('mergeText', () => {
  it('returns the other side when one side is unchanged', () => {
    expect(mergeText('a\nb\n', 'a\nb\n', 'a\nB\n')).toEqual({ text: 'a\nB\n', clean: true })
    expect(mergeText('a\nb\n', 'A\nb\n', 'a\nb\n')).toEqual({ text: 'A\nb\n', clean: true })
  })
  it('merges disjoint edits', () => {
    expect(mergeText('1\n2\n3\n4\n', '1x\n2\n3\n4\n', '1\n2\n3\n4y\n')).toEqual({
      text: '1x\n2\n3\n4y\n',
      clean: true,
    })
  })
  it('merges edits to different words on the same line by characters', () => {
    const r = mergeText('the quick brown fox\n', 'the QUICK brown fox\n', 'the quick brown FOX\n')
    expect(r).toEqual({ text: 'the QUICK brown FOX\n', clean: true })
  })
  it('keeps both sides, head first, when the same words changed', () => {
    const r = mergeText('title\n', 'title A\n', 'title B\n')
    expect(r.clean).toBe(false)
    expect(r.text).toBe('title A\ntitle B\n')
  })
  it('appends both texts for an empty base', () => {
    const r = mergeText('', 'from laptop\n', 'from phone\n')
    expect(r.text).toBe('from laptop\nfrom phone\n')
    expect(r.clean).toBe(false)
  })
  it('preserves CRLF and trailing newline from head', () => {
    expect(mergeText('a\r\nb\r\n', 'a\r\nb\r\nc\r\n', 'A\r\nb\r\n').text).toBe('A\r\nb\r\nc\r\n')
    expect(mergeText('a\nb', 'a\nb', 'a\nB').text).toBe('a\nB')
  })
  it('handles identical edits on both sides', () => {
    expect(mergeText('a\n', 'b\n', 'b\n')).toEqual({ text: 'b\n', clean: true })
  })
  it('is deterministic', () => {
    const a = mergeText('x\ny\n', 'x1\ny\n', 'x2\ny\n')
    const b = mergeText('x\ny\n', 'x1\ny\n', 'x2\ny\n')
    expect(a).toEqual(b)
  })
})

describe('conflictCopyName', () => {
  it('follows Obsidian naming', () => {
    const at = new Date(Date.UTC(2026, 8, 4, 15, 30))
    expect(conflictCopyName('Folder/Note.md', 'laptop', at)).toBe(
      'Folder/Note (Conflicted copy laptop 202609041530).md'
    )
    expect(conflictCopyName('Note.md', 'my:phone/2', at)).toBe(
      'Note (Conflicted copy my-phone-2 202609041530).md'
    )
  })
})

describe('frontmatterIsValid', () => {
  it('accepts no frontmatter, a map, and rejects broken yaml or a scalar', () => {
    expect(frontmatterIsValid('# hi\n')).toBe(true)
    expect(frontmatterIsValid('---\ngroups:\n  - "[[A]]"\n---\nbody')).toBe(true)
    expect(frontmatterIsValid('---\ngroups: [\n---\nbody')).toBe(false)
    expect(frontmatterIsValid('---\njust a string\n---\n')).toBe(false)
  })
  it('rejects an alias bomb without expanding it', () => {
    // An expanded bomb is a valid map, so `false` is only reached through the parser refusing
    // the alias count — no clock needed to tell a refusal from an expansion.
    const bomb =
      '---\na: &a ["x","x","x","x","x","x","x","x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n---\n'
    expect(frontmatterIsValid(bomb)).toBe(false)
  })
})

describe('mergeText, conflict regions', () => {
  it('keeps both sides when the character pass applies only some hunks', () => {
    // Two hunks: alpha→ALPHA applies; delta→DELTA does not, because head changed its context.
    const r = mergeText(
      'alpha beta gamma delta\n',
      'alpha beta gamma delta!\n',
      'ALPHA beta gamma DELTA\n'
    )
    expect(r).toEqual({ text: 'alpha beta gamma delta!\nALPHA beta gamma DELTA\n', clean: false })
  })
  it('keeps the edited line when head deleted it', () => {
    expect(mergeText('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n')).toEqual({
      text: 'a\nB\nc\n',
      clean: false,
    })
  })
  it('keeps both insertions, head first, when both sides insert at the same spot', () => {
    expect(mergeText('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n')).toEqual({
      text: 'a\nX\nY\nb\n',
      clean: false,
    })
  })
  it('applies the character pass when head shifted the line', () => {
    const r = mergeText('the quick brown fox\n', 'the QUICKER brown fox\n', 'the quick brown FOX\n')
    expect(r).toEqual({ text: 'the QUICKER brown FOX\n', clean: true })
  })
})

describe('mergeText, line endings', () => {
  it('uses CRLF from head when head switched to it and incoming uses LF', () => {
    expect(mergeText('a\nb\n', 'a\r\nb\r\nc\r\n', 'A\nb\n')).toEqual({
      text: 'A\r\nb\r\nc\r\n',
      clean: true,
    })
  })
  it("takes incoming's shape when head kept the base's", () => {
    expect(mergeText('a\nb', 'a\nb', 'a\nb\n').text).toBe('a\nb\n')
    expect(mergeText('a\nb', 'A\nb', 'a\nb\n').text).toBe('A\nb\n')
    expect(mergeText('a\nb\n', 'a\nb\n', 'a\r\nb\r\n').text).toBe('a\r\nb\r\n')
    expect(mergeText('a\r\nb\r\n', 'a\r\nb\r\nc\r\n', 'A\nb\n').text).toBe('A\nb\nc\n')
  })
  it("keeps head's shape when both sides changed it", () => {
    expect(mergeText('a\nb', 'a\nb\n', 'a\r\nb\r\n').text).toBe('a\nb\n')
  })
  it('follows the non-empty side when the other is empty', () => {
    expect(mergeText('', '', 'a\r\n')).toEqual({ text: 'a\r\n', clean: true })
    expect(mergeText('', '', 'a')).toEqual({ text: 'a', clean: true })
    expect(mergeText('a\r\n', 'b\r\n', '')).toEqual({ text: 'b\r\n', clean: false })
  })
})

describe('mergeText, long spans', () => {
  const base = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.\n'
  const head = base.replace('adipiscing', 'ADIPISCING')
  it('keeps a head edit inside a line incoming deleted', () => {
    const r = mergeText(base, head, '')
    expect(r.clean).toBe(false)
    expect(r.text).toContain('ADIPISCING')
    const kept = mergeText('h1\n' + base + 'h2\n', 'h1\n' + head + 'h2\n', 'h1\nh2\n')
    expect(kept.clean).toBe(false)
    expect(kept.text).toBe('h1\n' + head + 'h2\n')
  })
  it('keeps a head edit inside a paragraph incoming rewrote', () => {
    const r = mergeText(base, head, 'New paragraph.\n')
    expect(r.clean).toBe(false)
    expect(r.text).toContain('ADIPISCING')
    expect(r.text).toContain('New paragraph.')
  })
  it('keeps a head edit to the middle line of a paragraph incoming replaced', () => {
    const first = 'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium.\n'
    const last = 'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit.\n'
    const r = mergeText(first + base + last, first + head + last, 'Short.\n')
    expect(r.clean).toBe(false)
    expect(r.text).toContain('ADIPISCING')
    expect(r.text).toContain('Short.')
  })
})

describe('mergeText, large conflicts', () => {
  it('merges a 5000-line document changed entirely on both sides without a character pass', () => {
    const lines = (prefix: string) =>
      Array.from({ length: 5000 }, (_, i) => `${prefix} ${i}\n`).join('')
    let r = { text: '', clean: true }
    const work = charPassWork(() => {
      r = mergeText(lines('base'), lines('head'), lines('incoming'))
    })
    expect(work).toEqual({ calls: 0, chars: 0 })
    expect(r.clean).toBe(false)
    expect(r.text).toContain('head 4999\n')
    expect(r.text).toContain('incoming 4999\n')
  })
})

describe('mergeText, empty documents', () => {
  it('returns the only document when the base and the other side are empty', () => {
    expect(mergeText('', '', 'a\n')).toEqual({ text: 'a\n', clean: true })
    expect(mergeText('', 'a\n', '')).toEqual({ text: 'a\n', clean: true })
    expect(mergeText('', 'a\n', 'a\n')).toEqual({ text: 'a\n', clean: true })
  })
  it('returns empty when one side deleted everything and the other is unchanged', () => {
    expect(mergeText('a\n', 'a\n', '')).toEqual({ text: '', clean: true })
    expect(mergeText('a\n', '', 'a\n')).toEqual({ text: '', clean: true })
  })
  it('keeps the edit when one side deleted everything and the other edited', () => {
    expect(mergeText('a\n', '', 'b\n')).toEqual({ text: 'b\n', clean: false })
  })
})

describe('conflictCopyName, edge cases', () => {
  const at = new Date(Date.UTC(2026, 0, 5, 3, 7))
  it('rejects a forbidden dotfile and adds nothing to a path without extension', () => {
    expect(() => conflictCopyName('.hidden', 'laptop', at)).toThrowError(
      expect.objectContaining({ code: 'invalid_path' })
    )
    expect(conflictCopyName('Folder/Note', 'laptop', at)).toBe(
      'Folder/Note (Conflicted copy laptop 202601050307)'
    )
    expect(conflictCopyName('a/b/Note.tar.gz', 'laptop', at)).toBe(
      'a/b/Note.tar (Conflicted copy laptop 202601050307).gz'
    )
  })
  it('replaces control characters and truncates the device name to 40 characters', () => {
    const name = 'a' + String.fromCharCode(9) + 'b' + String.fromCharCode(0) + 'c<d>e"f|g?h*i\\j'
    expect(conflictCopyName('N.md', name, at)).toBe(
      'N (Conflicted copy a-b-c-d-e-f-g-h-i-j 202601050307).md'
    )
    expect(conflictCopyName('N.md', 'x'.repeat(50), at)).toBe(
      `N (Conflicted copy ${'x'.repeat(40)} 202601050307).md`
    )
  })
  it('formats the time in UTC', () => {
    expect(conflictCopyName('N.md', 'd', new Date('2026-12-31T23:59:59.999Z'))).toBe(
      'N (Conflicted copy d 202612312359).md'
    )
  })
  it('trims, collapses runs of dashes, and falls back to "device"', () => {
    expect(conflictCopyName('N.md', '[laptop]', at)).toBe(
      'N (Conflicted copy -laptop- 202601050307).md'
    )
    expect(conflictCopyName('N.md', '[[my#lap^top]]', at)).toBe(
      'N (Conflicted copy -my-lap-top- 202601050307).md'
    )
    expect(conflictCopyName('N.md', '  laptop  ', at)).toBe(
      'N (Conflicted copy laptop 202601050307).md'
    )
    expect(conflictCopyName('N.md', '', at)).toBe('N (Conflicted copy device 202601050307).md')
    expect(conflictCopyName('N.md', '   ', at)).toBe('N (Conflicted copy device 202601050307).md')
  })
})

describe('frontmatterIsValid, edge cases', () => {
  it('accepts CRLF frontmatter and still rejects broken CRLF frontmatter', () => {
    expect(frontmatterIsValid('---\r\ntitle: x\r\n---\r\nbody')).toBe(true)
    expect(frontmatterIsValid('---\r\ntitle: [\r\n---\r\n')).toBe(false)
  })
  it('rejects a list and a block over 64 KB, accepts one under it', () => {
    expect(frontmatterIsValid('---\n- a\n- b\n---\n')).toBe(false)
    expect(frontmatterIsValid('---\nk: ' + 'v'.repeat(65536) + '\n---\n')).toBe(false)
    expect(frontmatterIsValid('---\nk: ' + 'v'.repeat(60000) + '\n---\n')).toBe(true)
  })
  it('accepts an empty, comment-only, or blank-line-only block', () => {
    expect(frontmatterIsValid('---\n\n---\nbody')).toBe(true)
    expect(frontmatterIsValid('---\n# c\n---\n')).toBe(true)
    expect(frontmatterIsValid('---\n---\nbody')).toBe(true)
  })
  it('sees no frontmatter when --- is not the first line or the block never closes', () => {
    expect(frontmatterIsValid('\n---\nbad: [\n---\n')).toBe(true)
    expect(frontmatterIsValid('---\nbad: [\n')).toBe(true)
  })
})

describe('mergeText, character-pass budget', () => {
  // A region of 50 lines of 80 characters is 4 050 bytes a side: under the per-region cap, and
  // 12 150 bytes of budget per attempt, so the sixth such region exhausts the 64 KB budget.
  const region = (r: number, side: string) =>
    Array.from({ length: 50 }, (_, i) => `${side} ${r} ${i}`.padEnd(80, '.') + '\n').join('')
  const doc = (regions: number, side: string) =>
    Array.from({ length: regions }, (_, r) => region(r, side) + `sep ${r}\n`).join('')

  it('merges 100 conflict regions of 4 KB each within the 64 KB budget, unclean', () => {
    let r = { text: '', clean: true }
    const work = charPassWork(() => {
      r = mergeText(doc(100, 'base'), doc(100, 'head'), doc(100, 'incoming'))
    })
    // Five regions fit the budget; the sixth exhausts it and the other 95 are never attempted.
    expect(work.calls).toBe(5)
    expect(work.chars).toBeLessThanOrEqual(64 * 1024)
    expect(r.clean).toBe(false)
    expect(r.text).toContain('head 99 49')
    expect(r.text).toContain('incoming 99 49')
  })

  it('does not attempt a region over 64 lines or 4 KB a side, even with budget left', () => {
    const lines = (n: number, side: string) =>
      Array.from({ length: n }, (_, i) => `${side} ${i}\n`).join('')
    const attempts = (base: string, head: string, incoming: string) =>
      charPassWork(() => mergeText(base, head, incoming)).calls
    expect(attempts(lines(64, 'b'), lines(64, 'h'), lines(64, 'i'))).toBe(1)
    expect(attempts(lines(65, 'b'), lines(65, 'h'), lines(65, 'i'))).toBe(0)
    const long = (side: string) => side + 'x'.repeat(4096) + '\n'
    expect(attempts(long('b'), long('h'), long('i'))).toBe(0)
  })

  it('leaves two small regions that merge by characters clean', () => {
    const base = 'the quick brown fox\nsep\nlazy dogs sleep\n'
    const head = 'the QUICK brown fox\nsep\nLAZY dogs sleep\n'
    const incoming = 'the quick brown FOX\nsep\nlazy dogs SLEEP\n'
    expect(mergeText(base, head, incoming)).toEqual({
      text: 'the QUICK brown FOX\nsep\nLAZY dogs SLEEP\n',
      clean: true,
    })
  })

  it('keeps a later region as both sides once earlier regions spent the budget', () => {
    const small = {
      base: 'the quick brown fox\n',
      head: 'the QUICK brown fox\n',
      incoming: 'the quick brown FOX\n',
    }
    const alone = mergeText(small.base, small.head, small.incoming)
    expect(alone).toEqual({ text: 'the QUICK brown FOX\n', clean: true })

    const r = mergeText(
      doc(6, 'base') + small.base,
      doc(6, 'head') + small.head,
      doc(6, 'incoming') + small.incoming
    )
    // Every big region conflicts and is kept as both sides; the small one, which merges cleanly
    // on its own, is kept as both sides too because the budget ran out before it.
    const bothSides = Array.from(
      { length: 6 },
      (_, i) => region(i, 'head') + region(i, 'incoming') + `sep ${i}\n`
    ).join('')
    expect(r).toEqual({ text: bothSides + small.head + small.incoming, clean: false })
  })
})
