import { afterEach, expect, it } from 'vitest'
import { acceptanceFixture, type AcceptanceFixture } from './fixture.js'
let fixture: AcceptanceFixture | undefined
afterEach(async () => {
  await fixture?.close()
})
it('holds a real response at a deterministic barrier without blocking the other server', async () => {
  fixture = await acceptanceFixture()
  const device = fixture.devices[0]!
  const barrier = device.network.delayNextResponse((url) =>
    url.includes(fixture!.servers[0]!.address)
  )
  let delivered = false
  const slow = device
    .connection('server-1')
    .access.connection()
    .then((result) => {
      delivered = true
      return result
    })
  await barrier.entered
  expect(delivered).toBe(false)
  expect((await device.connection('server-2').access.connection()).status).toBe('active')
  barrier.release()
  expect((await slow).status).toBe('active')
})
it('loses a real issuance response after durable server mutation, then reconnects independently', async () => {
  fixture = await acceptanceFixture()
  const device = fixture.devices[0]!,
    server = fixture.servers[0]!,
    root = fixture.roots[0]!
  const before = await server.db.selectFrom('access_tokens').selectAll().execute()
  device.network.dropNextResponse((url, method) => url.endsWith('/v2/tokens') && method === 'POST')
  await expect(
    device.issue('server-1', { kind: 'folder', id: root.info.scope.id }, 'Lost response')
  ).rejects.toMatchObject({ code: 'offline' })
  expect(await server.db.selectFrom('access_tokens').selectAll().execute()).toHaveLength(
    before.length + 1
  )
  device.network.disconnect(server.address)
  await expect(device.connection('server-1').access.connection()).rejects.toMatchObject({
    code: 'offline',
  })
  expect((await device.connection('server-2').access.connection()).status).toBe('active')
  device.network.reconnect(server.address)
  expect((await device.connection('server-1').access.connection()).status).toBe('active')
})
