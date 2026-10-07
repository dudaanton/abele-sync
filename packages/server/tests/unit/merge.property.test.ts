import { it, expect } from 'vitest'
import fc from 'fast-check'
import { mergeText } from '../../src/merge/index.js'

const doc = fc
  .array(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 12 })
  .map((l) => l.map((x) => x + '\n').join(''))
const edit = (s: string) =>
  fc.constantFrom(s, s + 'z\n', s.replace(/a\n/, 'A\n'), s.replace(/c\n/, ''), 'q\n' + s)
const triple = doc.chain((b) => fc.tuple(fc.constant(b), edit(b), edit(b)))

it('merge(b, x, x) = x; merge(b, b, y) = y; merge(b, x, b) = x', () => {
  fc.assert(
    fc.property(triple, ([b, x, y]) => {
      expect(mergeText(b, x, x).text).toBe(x)
      expect(mergeText(b, b, y).text).toBe(y)
      expect(mergeText(b, x, b).text).toBe(x)
    })
  )
})

it('never loses a line present in both sides, and is deterministic', () => {
  fc.assert(
    fc.property(triple, ([b, x, y]) => {
      const m = mergeText(b, x, y)
      for (const line of x.split('\n')) {
        if (line && y.includes(line + '\n')) expect(m.text).toContain(line)
      }
      expect(mergeText(b, x, y)).toEqual(m)
    })
  )
})
