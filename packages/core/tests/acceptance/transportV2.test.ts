import { describe, expect, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import { V2EngineClient, sha256, encodeText } from '../../src/index.js'

describe('production v2 transport paging and multipart routes', () => {
  it('continues a scoped manifest instead of rereading page one', async () => {
    const f = await acceptanceFixture()
    try {
      const a = f.devices[0]!
      for (const path of ['One.md', 'Two.md', 'Three.md']) await a.write(path, path)
      await a.sync('server-1')
      const client = new V2EngineClient(a.connection('server-1').token, { fetch })
      const first = await client.manifest(null, 1)
      expect(first.next).not.toBeNull()
      const second = await client.manifest(first.next, 1)
      expect(second.items[0]!.file_id).not.toBe(first.items[0]!.file_id)
    } finally {
      await f.close()
    }
  })
  it('uses the published multipart begin/part/complete contract', async () => {
    const f = await acceptanceFixture()
    try {
      const a = f.devices[0]!
      const client = new V2EngineClient(a.connection('server-1').token, {
        fetch,
        simpleUploadBytes: 1,
      })
      const bytes = encodeText('multipart content'),
        sha = await sha256(bytes)
      await client.putBlob(sha, bytes)
      const outcome = await client.commit(
        [
          {
            op: 'create',
            path: 'asset.bin',
            sha,
            size: bytes.length,
            mtime: 1000,
          },
        ],
        crypto.randomUUID()
      )
      expect(outcome.results[0]!.status).toBe('applied')
    } finally {
      await f.close()
    }
  })
})
