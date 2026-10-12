import { it, expect } from 'vitest'
import fc from 'fast-check'
import { mergeText } from '../../src/merge/index.js'

it('merges arbitrary separate-line replacements and never character-merges same-line words', () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 }), (p, q) => {
      const base = Array.from({ length: 5 }, (_, i) => `line ${i}: first middle last`)
      const head = [...base],
        incoming = [...base]
      head[p] = head[p]!.replace('first', 'FIRST')
      incoming[q] = incoming[q]!.replace('last', 'LAST')
      const text = (lines: string[]) => lines.join('\n') + '\n'
      const result = mergeText(text(base), text(head), text(incoming))
      if (p === q) expect(result).toEqual({ text: text(head), clean: false, conflictCopy: true })
      else {
        const expected = [...head]
        expected[q] = incoming[q]!
        expect(result).toEqual({ text: text(expected), clean: true })
      }
    })
  )
})

it('does not confuse a shared insertion with a replacement of a base line', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 8 }),
      fc.boolean(),
      fc.boolean(),
      (padding, reverse, extraInsert) => {
        const prefix = Array.from({ length: padding }, (_, i) => `prefix-${i}`)
        const suffix = Array.from({ length: padding }, (_, i) => `suffix-${i}`)
        const text = (body: string[]) => [...prefix, ...body, ...suffix].join('\n') + '\n'
        const base = text(['a', 'b'])
        const head = text(['X', 'a', 'Y'])
        const incoming = text(['X', 'b', ...(extraInsert ? ['Z'] : [])])
        const result = reverse ? mergeText(base, incoming, head) : mergeText(base, head, incoming)
        if (result.clean)
          expect(result.text).toBe(text(['X', 'X', 'Y', ...(extraInsert ? ['Z'] : [])]))
        else
          expect(result).toEqual({
            text: reverse ? incoming : head,
            clean: false,
            conflictCopy: true,
          })
      }
    ),
    { seed: 3107, numRuns: 300 }
  )
})

it('preserves both base-coordinate edit plans or returns a whole-document conflict, with insertions and replacements on both sides', () => {
  const plans = fc
    .integer({ min: 2, max: 8 })
    .chain((n) =>
      fc.tuple(
        fc.constant(n),
        fc.array(fc.boolean(), { minLength: n, maxLength: n }),
        fc.array(fc.boolean(), { minLength: n, maxLength: n }),
        fc.array(fc.boolean(), { minLength: n + 1, maxLength: n + 1 }),
        fc.array(fc.boolean(), { minLength: n + 1, maxLength: n + 1 })
      )
    )
  fc.assert(
    fc.property(plans, ([n, headReplace, incomingReplace, headInsert, incomingInsert]) => {
      const base = Array.from({ length: n }, (_, i) => `base-${i}`)
      const side = (replace: boolean[], insert: boolean[], label: string) => {
        const lines: string[] = []
        for (let i = 0; i <= n; i++) {
          if (insert[i]) lines.push(`${label}-insert-${i}`)
          if (i < n) lines.push(replace[i] ? `${label}-replace-${i}` : base[i]!)
        }
        return lines
      }
      const head = side(headReplace, headInsert, 'head'),
        incoming = side(incomingReplace, incomingInsert, 'incoming')
      const text = (lines: string[]) => lines.join('\n') + '\n'
      for (const reverse of [false, true]) {
        const result = mergeText(
          text(base),
          text(reverse ? incoming : head),
          text(reverse ? head : incoming)
        )
        const overlapping =
          headReplace.some((v, i) => v && incomingReplace[i]) ||
          headInsert.some((v, i) => v && incomingInsert[i])
        if (result.clean) {
          expect(overlapping).toBe(false)
          const expected: string[] = []
          for (let i = 0; i <= n; i++) {
            if (headInsert[i]) expected.push(`head-insert-${i}`)
            if (incomingInsert[i]) expected.push(`incoming-insert-${i}`)
            if (i < n)
              expected.push(
                headReplace[i]
                  ? `head-replace-${i}`
                  : incomingReplace[i]
                    ? `incoming-replace-${i}`
                    : base[i]!
              )
          }
          expect(result.text).toBe(text(expected))
        } else
          expect(result).toEqual({
            text: text(reverse ? incoming : head),
            clean: false,
            conflictCopy: true,
          })
      }
    }),
    { seed: 3108, numRuns: 2000 }
  )
})

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
