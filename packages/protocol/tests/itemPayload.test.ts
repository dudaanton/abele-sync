import { expect, it } from 'vitest'
import { decodeAccessToken, encodeAccessToken } from '../src/v2.js'

it('round trips legacy and set previews', () => {
  const common = { address: 'https://sync.example', key: 'a'.repeat(43) }
  const legacy = {
    ...common,
    v: 1 as const,
    scope: { kind: 'folder' as const, id: 'root', path: '/' },
  }
  expect(decodeAccessToken(encodeAccessToken(legacy))).toEqual(legacy)
  const set = {
    ...common,
    v: 2 as const,
    items: [{ id: 'item', kind: 'file' as const, scope_id: 'file', path: 'a.md' }],
  }
  expect(decodeAccessToken(encodeAccessToken(set))).toEqual(set)
  expect(() => decodeAccessToken(btoa(JSON.stringify({ ...set, items: [] })))).toThrow()
  expect(() =>
    decodeAccessToken(
      btoa(JSON.stringify({ ...legacy, scope: { kind: 'file', id: 'file', path: 'a.md' } }))
    )
  ).toThrow()
})
