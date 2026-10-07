import { expect, it, vi } from 'vitest'
import { createScopedClient } from '../../src/scopedClient.js'
it('uses the scoped upload namespace, resuming bounded parts instead of a personal/blob fallback', async () => {
  const calls: string[] = [],
    bytes = new Uint8Array(9 * 1024 * 1024),
    sha = 'a'.repeat(64)
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/begin'))
      return new Response(
        JSON.stringify({ upload_id: 'upload', part_size: 1024 * 1024, parts: 9, received: [0] }),
        { status: 201 }
      )
    if (init?.method === 'PUT' && url.includes('/upload/'))
      return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ sha, size: bytes.length }), { status: 201 })
  })
  const client = await createScopedClient({
    baseUrl: 'https://issuer.example.test',
    token: `absk_${'a'.repeat(43)}`,
    fetch: fetchMock as typeof fetch,
    vaultId: 'vault',
    grantId: 'grant',
    principalId: 'key',
    principalKind: 'key',
  })
  await client.putBlob(sha, bytes)
  expect(calls[0]).toBe(
    `https://issuer.example.test/v1/scoped/vaults/vault/grants/grant/uploads/${sha}/begin`
  )
  expect(calls).toHaveLength(10)
  expect(calls.at(-1)).toContain('/upload/complete')
  expect(calls.some((url) => url.endsWith('/upload/0'))).toBe(false)
})
