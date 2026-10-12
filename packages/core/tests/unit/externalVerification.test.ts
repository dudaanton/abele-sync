import { describe, expect, it, vi } from 'vitest'
import { V2EngineClient } from '../../src/v2Client.js'
import { encodeAccessToken } from '@abele/sync-protocol'

const capabilities = {
  extension_version: 1,
  projection_schema: 1,
  token: true,
  verification: { live_head: true, sha256: true, actual_size: true, authorization_rechecked: true },
  max_file_size: 200 * 1024 * 1024,
}
const expected = { version_id: 'v', path: 'Agents/a.bin', sha: 'a'.repeat(64), size: 12 }
const response = { verified: true, file_id: 'file', ...expected }
async function client(_mode: 'token', fetch: typeof globalThis.fetch) {
  return new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'https://issuer.example.test',
      key: 'k'.repeat(43),
      scope: { kind: 'folder', id: 'folder', path: '/' },
    }),
    { fetch }
  )
}
for (const mode of ['token'] as const)
  describe(`external verification client (${mode})`, () => {
    it('BUG: negotiates and verifies the exact request with version headers and no fallback', async () => {
      const requests: { url: string; init: RequestInit }[] = []
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), init: init! })
        return new Response(JSON.stringify(requests.length === 1 ? capabilities : response))
      })
      const c = await client(mode, fetch as typeof globalThis.fetch)
      expect(await c.verifyExternalFile('file', expected)).toEqual(response)
      expect(requests.map((r) => r.url)).toEqual([
        'https://issuer.example.test/v2/external-files/capabilities',
        'https://issuer.example.test/v2/files/file/external/verify',
      ])
      expect(requests[1]!.init.headers).toMatchObject({ 'x-abele-external-files-version': '1' })
      expect(JSON.parse(String(requests[1]!.init.body))).toEqual(expected)
    })
    for (const unavailable of ['absent', 'unknown', 'partial', 'disabled', 'malformed'] as const)
      it(`BUG: ${unavailable} extension refuses verification before any destructive continuation`, async () => {
        const body =
          unavailable === 'absent'
            ? { error: { code: 'not_found', message: 'old server', details: {} } }
            : unavailable === 'unknown'
              ? { ...capabilities, extension_version: 2 }
              : unavailable === 'partial'
                ? { ...capabilities, verification: { live_head: true } }
                : unavailable === 'disabled'
                  ? { ...capabilities, [mode]: false }
                  : 'not JSON'
        const fetch = vi.fn(
          async () =>
            new Response(unavailable === 'malformed' ? String(body) : JSON.stringify(body), {
              status: unavailable === 'absent' ? 404 : 200,
            })
        )
        const c = await client(mode, fetch as typeof globalThis.fetch),
          removeOriginal = vi.fn()
        const original = Buffer.from('original is still present')
        const operation = async () => {
          await c.verifyExternalFile('file', expected)
          removeOriginal()
        }
        await expect(operation()).rejects.toMatchObject({ code: 'external_files_unavailable' })
        expect(removeOriginal).not.toHaveBeenCalled()
        expect(original.toString()).toBe('original is still present')
        expect(fetch).toHaveBeenCalledTimes(1)
      })
    for (const mismatch of [
      { file_id: 'other' },
      { version_id: 'other' },
      { path: 'Agents/b.bin' },
      { sha: 'b'.repeat(64) },
      { size: 13 },
      { verified: false },
    ])
      it(`BUG: rejects mismatched verification response ${JSON.stringify(mismatch)}`, async () => {
        let calls = 0
        const fetch = vi.fn(
          async () =>
            new Response(
              JSON.stringify(++calls === 1 ? capabilities : { ...response, ...mismatch })
            )
        )
        const c = await client(mode, fetch as typeof globalThis.fetch)
        await expect(c.verifyExternalFile('file', expected)).rejects.toMatchObject({
          code: 'protocol',
        })
      })
    it('BUG: respects the negotiated size ceiling before verification', async () => {
      const fetch = vi.fn(
        async () => new Response(JSON.stringify({ ...capabilities, max_file_size: 10 }))
      )
      const c = await client(mode, fetch as typeof globalThis.fetch)
      await expect(c.verifyExternalFile('file', expected)).rejects.toMatchObject({
        code: 'too_large',
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    })
    for (const status of [401, 403])
      for (const body of ['<html>Access denied by proxy</html>', '{"message":"Access denied"}'])
        it(`BUG: preserves non-envelope HTTP ${status} access refusal (${body})`, async () => {
          const fetch = vi.fn(async () => new Response(body, { status }))
          const c = await client(mode, fetch as typeof globalThis.fetch)
          const removeOriginal = vi.fn()
          await expect(
            c.verifyExternalFile('file', expected).then(removeOriginal)
          ).rejects.toMatchObject({
            code: status === 401 ? 'unauthorized' : 'forbidden',
            status,
          })
          expect(removeOriginal).not.toHaveBeenCalled()
          expect(fetch).toHaveBeenCalledTimes(1)
        })
    it('BUG: preserves offline and access failures rather than falling back to personal verification', async () => {
      const fetch = vi.fn(async () => {
        throw new Error('network down')
      })
      const c = await client(mode, fetch as typeof globalThis.fetch)
      await expect(c.verifyExternalFile('file', expected)).rejects.toMatchObject({
        code: 'offline',
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  })
it('BUG: personal head sends extension version and decodes existing manifest metadata', async () => {
  const head = { file_id: 'file', ...expected, kind: 'attachment', seq: 1, mtime: 1 }
  const fetch = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(head))
  )
  const c = await client('token', fetch as typeof globalThis.fetch)
  expect(await c.head('file')).toEqual(head)
  expect(fetch.mock.calls[0]![0]).toBe('https://issuer.example.test/v2/files/file/head')
  expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ 'x-abele-external-files-version': '1' })
})
