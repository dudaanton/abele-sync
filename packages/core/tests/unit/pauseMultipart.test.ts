import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import { V2EngineClient } from '../../src/v2Client.js'
import { stoppableClient } from '../../src/guard.js'

it('cancels an in-flight buffered multipart upload before another part or completion', async () => {
  const controller = new AbortController()
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests: string[] = []
  const transport = new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'https://synthetic.example.test',
      key: 'k'.repeat(43),
      scope: { kind: 'folder', id: 'folder', path: '/' },
    }),
    {
      simpleUploadBytes: 0,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname
        requests.push(path)
        if (path.endsWith('/begin'))
          return Response.json({ upload_id: 'upload', part_size: 2, parts: 3, received: [] })
        if (path.endsWith('/0')) {
          entered()
          await gate
        }
        return new Response(null, { status: 201 })
      },
    }
  )
  const client = stoppableClient(transport, () => controller.signal, { count: 0 })
  const upload = client.putBlob('a'.repeat(64), new Uint8Array(6)).catch((e) => e)
  await reached
  controller.abort()
  release()
  expect(await upload).toBeInstanceOf(Error)
  expect(requests.map((path) => path.split('/').at(-1))).toEqual(['begin', '0'])
})
