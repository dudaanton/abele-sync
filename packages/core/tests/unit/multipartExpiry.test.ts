import { expect, it } from 'vitest'
import { encodeAccessToken } from '@abele/sync-protocol'
import { V2EngineClient } from '../../src/v2Client.js'
import { sha256 } from '../../src/hash.js'

it.each(['buffered-part', 'buffered-complete', 'stream-part', 'stream-complete'])(
  'reopens an expired multipart session transparently (%s)',
  async (mode) => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]),
      sha = await sha256(bytes)
    let begins = 0,
      lost = false,
      completed = 0,
      closed = 0
    const sessions = new Map<string, Map<number, Uint8Array>>()
    const client = new V2EngineClient(
      encodeAccessToken({
        v: 1,
        address: 'https://synthetic.test',
        key: 'k'.repeat(43),
        scope: { kind: 'folder', id: 'root', path: '/' },
      }),
      {
        simpleUploadBytes: 0,
        fetch: async (url, init) => {
          if (init?.method === 'HEAD') return new Response(null, { status: completed ? 200 : 404 })
          const parts = new URL(String(url)).pathname.split('/')
          if (parts.at(-1) === 'begin') {
            const id = `session${++begins}`
            sessions.set(id, new Map())
            return Response.json({ upload_id: id, part_size: 2, parts: 3, received: [] })
          }
          const id = parts.at(-2)!,
            part = parts.at(-1)!
          if (!lost && part === (mode.endsWith('part') ? '1' : 'complete')) {
            lost = true
            sessions.delete(id)
            return Response.json(
              { error: { code: 'not_found', message: 'no upload ' + id } },
              { status: 404 }
            )
          }
          const session = sessions.get(id)!
          if (part === 'complete') {
            expect([...session.values()].flatMap((b) => [...b])).toEqual([...bytes])
            completed++
            return Response.json({ sha, size: bytes.length }, { status: 201 })
          }
          session.set(Number(part), new Uint8Array(await new Response(init?.body).arrayBuffer()))
          return new Response(null, { status: 204 })
        },
      }
    )
    if (mode.startsWith('buffered')) await client.putBlob(sha, bytes)
    else
      await client.putBlobSource(
        { sha, size: bytes.length },
        {
          size: bytes.length,
          read: async (at, length) => bytes.slice(at, at + length),
          assertUnchanged: async () => {},
          close: async () => {
            closed++
          },
        }
      )
    expect(begins).toBe(2)
    expect(completed).toBe(1)
    expect(closed).toBe(mode.startsWith('buffered') ? 0 : 1)
  }
)
