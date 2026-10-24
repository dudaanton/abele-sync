import { expect, it } from 'vitest'
import { validatePath } from '../src/paths.js'

it.each([
  'a:b',
  'a*b',
  'a?b',
  'a"b',
  'a<b',
  'a>b',
  'a|b',
  'tail.',
  'tail ',
  'CON',
  'prn.txt',
  'com1/file',
])('accepts platform-neutral wire name %s (D-011)', (path) => {
  expect(() => validatePath(path)).not.toThrow()
})
