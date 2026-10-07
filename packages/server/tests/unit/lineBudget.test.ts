import { expect, it, vi } from 'vitest'
import { diff3Merge } from 'node-diff3'
import { mergeText } from '../../src/merge/diff3.js'

vi.mock('node-diff3', () => ({ diff3Merge: vi.fn(() => []) }))
it.each([2000, 100_000])('refuses %i repeated lines before entering synchronous LCS', (count) => {
  const base = 'repeat\n'.repeat(count)
  const head = 'head edit\n' + base,
    incoming = base + 'incoming edit\n'
  const result = mergeText(base, head, incoming)
  expect(diff3Merge).not.toHaveBeenCalled()
  // Budget refusal is not a textual merge. The commit layer keeps incoming in a copy,
  // covered end-to-end by adversarialConflicts; never publish a concatenated head here.
  expect(result).toEqual({ text: head, clean: false, conflictCopy: true })
})
