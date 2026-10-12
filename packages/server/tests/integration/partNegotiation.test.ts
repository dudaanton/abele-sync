import { expect, it } from 'vitest'
import { createUser } from '../../src/access/tokens.js'
import { v2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  it.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `negotiates and persists a bounded multipart layout (${dialect})`,
    async () => {
      const server = await v2Server(dialect)
      try {
        const issued = await createUser(
          { db: server.db, dialect, pepper: server.config.tokenPepper },
          'Owner',
          server.address
        )
        const client = new V2SyncClient(issued.token)
        const path = '/uploads/' + 'a'.repeat(64) + '/begin'
        const first = await client.json(path, 'POST', {
          size: 2 * 1024 * 1024,
          max_part_bytes: 1024 * 1024,
        })
        expect(first.part_size).toBe(1024 * 1024)
        expect(first.parts).toBe(2)
        const resumed = await client.json(path, 'POST', {
          size: 2 * 1024 * 1024,
          max_part_bytes: 1024 * 1024,
        })
        expect(resumed.upload_id).toBe(first.upload_id)
        await expect(
          client.json(path, 'POST', { size: 2 * 1024 * 1024, max_part_bytes: 512 * 1024 })
        ).rejects.toThrow()
      } finally {
        await server.close()
      }
    }
  )
}
