import { afterEach, expect, it } from 'vitest'
import { decodeAccessToken } from '@abele/sync-protocol'
import { AccessClient } from '../../src/accessClient.js'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { v2Server, type V2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
let server: V2Server | undefined
afterEach(async () => {
  await server?.close()
})
it('uses the token address and key; server-returned selector replaces display hints', async () => {
  server = await v2Server()
  const root = await createUser(
    { db: server.db, pepper: server.config.tokenPepper },
    'Owner',
    server.address
  )
  const token = decodeAccessToken(root.token)
  if (token.v !== 1) throw new Error('root provisioning must retain the legacy payload')
  const client = new AccessClient(
    { ...token, scope: { kind: 'group', id: 'fake', path: 'Wrong.md' } },
    { fetch }
  )
  const connection = await client.connection()
  expect(connection.scope).toEqual(token.scope)
  const child = await client.issue({
    scope: { kind: 'folder', id: token.scope.id },
    label: 'Second',
  })
  expect((await client.tokens()).items.map((x) => x.id)).toContain(child.info.id)
  const second = AccessClient.fromToken(child.token, { fetch })
  await client.revoke(child.info.id)
  await expect(second.connection()).rejects.toMatchObject({ code: 'unauthorized' })
})
