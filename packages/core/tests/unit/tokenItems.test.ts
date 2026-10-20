import { expect, it, vi } from 'vitest'
import { AccessClient } from '../../src/accessClient.js'

it('reads issued token items through the authenticated transport with an encoded id', async () => {
  const items = {
    items: [
      {
        id: 'primary:child',
        scope_id: 'scope',
        scope: { kind: 'folder', id: 'folder', path: 'Shared' },
        added_at: '2026-10-20T00:00:00.000Z',
        removed_at: null,
      },
    ],
  }
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(items))
  const client = new AccessClient(
    {
      v: 1,
      address: 'https://example.test',
      key: 'a'.repeat(43),
      scope: { kind: 'folder', id: 'root', path: '/' },
    },
    { fetch }
  )
  expect(await client.tokenItems('child/id')).toEqual(items)
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toBe('https://example.test/v2/tokens/child%2Fid/items')
  expect(init?.method).toBe('GET')
  expect(init?.headers).toMatchObject({ authorization: `Bearer ${'a'.repeat(43)}` })
})

it('negotiates item counts and preserves them in token listings', async () => {
  const scope = { kind: 'folder' as const, id: 'root', path: '/' }
  const listing = {
    items: [
      {
        id: 'child',
        scope,
        label: 'Share',
        issued_by_token_id: 'issuer',
        created_at: '2026-10-20T00:00:00.000Z',
        revoked_at: null,
        item_count: 2,
      },
    ],
  }
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(listing))
  const client = new AccessClient(
    {
      v: 1,
      address: 'https://example.test',
      key: 'a'.repeat(43),
      scope,
    },
    { fetch }
  )
  expect(await client.tokens()).toEqual(listing)
  expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({
    'abele-client-capabilities': 'read-only,token-item-count',
  })
})
