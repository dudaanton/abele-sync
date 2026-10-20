import { expect, it } from 'vitest'
import {
  V2ScopeItemsResponseSchema,
  V2TokenItemsResponseSchema,
  V2TokensResponseSchema,
} from '../src/v2.js'

it('shares the holder item contract and accepts optional live item counts in token listings', () => {
  const scope = { kind: 'file', id: 'file', path: 'Shared/a.md' }
  const created_at = '2026-10-20T00:00:00.000Z'
  const inventory = {
    items: [
      {
        id: 'item',
        scope_id: 'scope',
        scope,
        added_at: created_at,
        removed_at: null,
      },
    ],
  }
  expect(V2TokenItemsResponseSchema.parse(inventory)).toEqual(
    V2ScopeItemsResponseSchema.parse(inventory)
  )
  const token = {
    id: 'token',
    scope,
    label: 'Share',
    issued_by_token_id: 'issuer',
    created_at,
    revoked_at: null,
  }
  expect(V2TokensResponseSchema.parse({ items: [token] }).items[0]).not.toHaveProperty('item_count')
  expect(
    V2TokensResponseSchema.parse({ items: [{ ...token, item_count: 0 }] }).items[0]!.item_count
  ).toBe(0)
  expect(V2TokensResponseSchema.safeParse({ items: [{ ...token, item_count: -1 }] }).success).toBe(
    false
  )
})
