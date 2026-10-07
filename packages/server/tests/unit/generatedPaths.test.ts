import { expect, it } from 'vitest'
import { caseKey, nextFreeName, validatePath } from '@abele/sync-protocol'
import { conflictCopyName } from '../../src/merge/conflictName.js'

it.each(['a'.repeat(252) + '.md', 'é'.repeat(126) + '.md'])(
  'bounds generated conflict and numbered names by UTF-8 bytes',
  (path) => {
    validatePath(path)
    const conflict = conflictCopyName(path, 'Cafe\u0301', new Date('2026-01-01T00:00:00Z'))
    expect(() => validatePath(conflict)).not.toThrow()
    expect(conflict).toBe(conflict.normalize('NFC'))
    const taken = new Set([caseKey(path)])
    const first = nextFreeName(path, (key) => taken.has(key))
    expect(() => validatePath(first)).not.toThrow()
    taken.add(caseKey(first))
    const second = nextFreeName(path, (key) => taken.has(key))
    expect(second).not.toBe(first)
    expect(() => validatePath(second)).not.toThrow()
  }
)

it('keeps a valid basename when four bytes remain for a numbered name', () => {
  const folder = Array(4).fill('x'.repeat(254)).join('/') + '/'
  const original = folder + 'a.md'
  validatePath(original)
  const numbered = nextFreeName(original, (key) => key === caseKey(original))
  expect(() => validatePath(numbered)).not.toThrow()
})

it('keeps generated names valid when the parent leaves no room for a suffix', () => {
  const folder = Array.from({ length: 4 }, () => 'x'.repeat(250)).join('/')
  const original = `${folder}/note.md`
  validatePath(original)
  const conflict = conflictCopyName(original, 'laptop', new Date('2026-01-01'))
  expect(() => validatePath(conflict)).not.toThrow()
  const numbered = nextFreeName(original, (key) => key === caseKey(original))
  expect(() => validatePath(numbered)).not.toThrow()
})
