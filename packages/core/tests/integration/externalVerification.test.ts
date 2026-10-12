import { describe, expect, it } from 'vitest'
import { encodeText, sha256 } from '../../src/hash.js'
import { V2EngineClient } from '../../src/v2Client.js'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { v2Server } from '@abele/sync-server/tests/helpers/v2Server.js'

describe('external verification client against real production v2 routes', () => {
  it('uses live metadata, verifies actual content, then refuses a deleted file', async () => {
    const server = await v2Server()
    try {
      const root = await createUser(
        { db: server.db, pepper: server.config.tokenPepper },
        'Owner',
        server.address
      )
      const client = new V2EngineClient(root.token, { fetch })
      const bytes = encodeText('attachment'),
        sha = await sha256(bytes)
      await client.putBlob(sha, bytes)
      const file = (
        await client.commit(
          [{ op: 'create', path: 'Assets/a.bin', sha, size: bytes.length, mtime: 1 }],
          'external-create'
        )
      ).results[0]!
      if (file.status !== 'applied') throw new Error('fixture did not create a live file')
      const head = await client.head(file.file_id)
      const expected = {
        version_id: head.version_id,
        path: head.path,
        sha: head.sha,
        size: head.size,
      }
      expect(await client.verifyExternalFile(file.file_id, expected)).toEqual({
        verified: true,
        file_id: head.file_id,
        ...expected,
      })
      expect(await client.versionBytes(file.file_id, head.version_id)).toEqual(bytes)
      await client.commit(
        [{ op: 'delete', file_id: file.file_id, base_version_id: file.version_id }],
        'external-delete'
      )
      await expect(client.verifyExternalFile(file.file_id, expected)).rejects.toMatchObject({
        code: 'not_found',
      })
      await expect(client.head(file.file_id)).rejects.toMatchObject({ code: 'not_found' })
    } finally {
      await server.close()
    }
  })
})
