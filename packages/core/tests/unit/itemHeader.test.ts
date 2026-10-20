import { expect, it } from 'vitest'
import { encodeAccessToken } from '@abele/sync-protocol'
import { V2EngineClient } from '../../src/v2Client.js'

it('sends the selected item on connection and manifest requests', async () => {
  const seen: Headers[] = []
  const client = new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'https://sync.example',
      key: 'a'.repeat(43),
      scope: { kind: 'folder', id: 'root', path: '/' },
    }),
    {
      item: 'item-id',
      fetch: async (url, init) => {
        seen.push(new Headers(init?.headers))
        if (String(url).includes('/manifest'))
          return Response.json({ items: [], cursor: 0, next: null })
        return Response.json({
          protocol: 2,
          token_id: 't',
          space_id: 's',
          scope: { kind: 'folder', id: 'folder', path: 'Shared' },
          status: 'active',
          limits: { max_file_bytes: 100, quota_bytes: null },
        })
      },
    }
  )
  await client.connection()
  await client.manifest(null)
  expect(seen.map((headers) => headers.get('abele-scope-item'))).toEqual(['item-id', 'item-id'])
})
