import { expect, it } from 'vitest'
import { tokenFixture } from '../helpers/tokenFixture.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { Connection031, TokenInfo031 } from '../helpers/protocol031.js'
import { AccessClient } from '@abele/sync-core'

it('v0.3.1 strict clients can connect and manage writable, read-only and scoped tokens', async () => {
  const f = await tokenFixture()
  try {
    const reader = await f.root.json('/tokens', 'POST', {
      scope: { kind: 'folder', id: f.share.info.scope.id },
      label: 'Reader',
      read_only: true,
    })
    for (const client of [f.root, f.guest, new V2SyncClient(reader.token)]) {
      expect(Connection031.safeParse(await client.json('/connection')).success).toBe(true)
      const listed = await client.json('/tokens')
      for (const item of listed.items) expect(TokenInfo031.safeParse(item).success).toBe(true)
      const scope = (await client.json('/connection')).scope
      const child = await client.json('/tokens', 'POST', {
        scope: { kind: scope.kind, id: scope.id },
        label: 'Legacy child',
      })
      expect(TokenInfo031.safeParse(child.info).success).toBe(true)
      expect(
        Connection031.safeParse(await new V2SyncClient(child.token).json('/connection')).success
      ).toBe(true)
    }
    // Updated clients explicitly opt in, including a reader delegating to another reader.
    const access = AccessClient.fromToken(reader.token, { fetch })
    expect((await access.connection()).read_only).toBe(true)
    expect(
      (
        await access.issue({
          scope: { kind: 'folder', id: f.share.info.scope.id },
          label: 'New child',
        })
      ).info.read_only
    ).toBe(true)
    expect((await access.tokens()).items.some((t) => t.read_only === true)).toBe(true)
    expect(
      (await new V2SyncClient(reader.token).request('/commit', 'POST', { ops: [] })).status
    ).toBe(403)
  } finally {
    await f.close()
  }
})
