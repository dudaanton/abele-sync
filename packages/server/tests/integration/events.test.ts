import type { AddressInfo } from 'node:net'
import type { EventFrame } from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { commit as post, create, putBlob as put } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

/** One connected client: the socket, the frames it heard, and the code it closed with. */
interface Client {
  socket: WebSocket
  frames: EventFrame[]
  closed: Promise<number>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `check` holds; a test that waits forever is a failed test, not a hung one. */
async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(10)
  }
}

/** Open the event socket of a listening app and collect whatever it says. */
async function open(app: FastifyInstance, vaultId: string): Promise<Client> {
  const { port } = app.server.address() as AddressInfo
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/vaults/${vaultId}/events`)
  const frames: EventFrame[] = []
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as EventFrame))
  // A socket the server hangs up on must not throw at the test process.
  socket.on('error', () => {})
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return { socket, frames, closed }
}

/** Say hello with a token and wait for the server to answer, one way or the other. */
const hello = (client: Client, token: string): void => {
  client.socket.send(JSON.stringify({ token }))
}

describe('event socket', () => {
  let t: TestApp
  let vaultA: string
  let vaultB: string
  let deviceA1: string
  let deviceA2: string
  let deviceB: string
  let accountToken: string
  const opened: Client[] = []

  beforeAll(async () => {
    t = await buildTestApp()
    await t.app.listen({ port: 0 })
    const account = await t.account()
    accountToken = account.accountToken
    vaultA = (await t.vault(accountToken, 'A')).vaultId
    vaultB = (await t.vault(accountToken, 'B')).vaultId
    deviceA1 = (await t.device(accountToken, vaultA, 'laptop')).deviceToken
    deviceA2 = (await t.device(accountToken, vaultA, 'phone')).deviceToken
    deviceB = (await t.device(accountToken, vaultB, 'other')).deviceToken
  })

  afterAll(async () => {
    for (const client of opened) client.socket.close()
    await t.close()
  })

  it('tells every device of the vault about a commit, once per debounce window', async () => {
    const a1 = await open(t.app, vaultA)
    const a2 = await open(t.app, vaultA)
    const b = await open(t.app, vaultB)
    opened.push(a1, a2, b)
    hello(a1, deviceA1)
    hello(a2, deviceA2)
    hello(b, deviceB)
    await until(() => t.hub.sockets(vaultA) === 2 && t.hub.sockets(vaultB) === 1, 'three sockets')

    await put(t.app, deviceA1, 'one\n')
    await put(t.app, deviceA1, 'two\n')
    // Two commits inside one window: one frame, carrying the later seq.
    await post(t.app, deviceA1, vaultA, [create('One.md', 'one\n')])
    await post(t.app, deviceA1, vaultA, [create('Two.md', 'two\n')])
    await wait(400)
    expect(a1.frames).toEqual([{ type: 'seq', head_seq: 2 }])
    expect(a2.frames).toEqual([{ type: 'seq', head_seq: 2 }])

    await put(t.app, deviceA1, 'three\n')
    await post(t.app, deviceA1, vaultA, [create('Three.md', 'three\n')])
    await wait(400)
    expect(a1.frames).toEqual([
      { type: 'seq', head_seq: 2 },
      { type: 'seq', head_seq: 3 },
    ])
    expect(a2.frames).toHaveLength(2)

    // Nothing that happened in vault A was ever any of vault B's business.
    expect(b.frames).toEqual([])
  })

  it('ignores whatever a client says after the hello, and forgets one that closes', async () => {
    const client = await open(t.app, vaultA)
    hello(client, deviceA1)
    await until(() => t.hub.sockets(vaultA) === 3, 'the fourth socket')
    client.socket.send('not a frame at all')
    client.socket.send(JSON.stringify({ token: 'absd_nonsense' }))
    await wait(50)
    expect(client.socket.readyState).toBe(WebSocket.OPEN)

    client.socket.close()
    await client.closed
    await until(() => t.hub.sockets(vaultA) === 2, 'the socket to be forgotten')
  })

  it('closes with 4001 on any token that is not a device of this vault', async () => {
    const other = await open(t.app, vaultA)
    hello(other, deviceB)
    expect(await other.closed).toBe(4001)

    const account = await open(t.app, vaultA)
    hello(account, accountToken)
    expect(await account.closed).toBe(4001)

    const unknown = await open(t.app, vaultA)
    hello(unknown, 'absd_not_a_real_token')
    expect(await unknown.closed).toBe(4001)

    const garbage = await open(t.app, vaultA)
    garbage.socket.send('{not json')
    expect(await garbage.closed).toBe(4001)

    const wrongShape = await open(t.app, vaultA)
    wrongShape.socket.send(JSON.stringify({ hello: 'there' }))
    expect(await wrongShape.closed).toBe(4001)

    expect(t.hub.sockets(vaultA)).toBe(2)
  })

  it('closes the socket of a device the moment it is revoked, however it is revoked', async () => {
    const vaultId = (await t.vault(accountToken, 'revoked')).vaultId
    const keeper = await t.device(accountToken, vaultId, 'keeper')
    const del = (url: string, token: string) =>
      t.app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${token}` } })
    const revokes: Array<(id: string, token: string) => Promise<unknown>> = [
      // By a sibling on the vault's own route.
      (id) => del(`/v1/vaults/${vaultId}/devices/${id}`, keeper.deviceToken),
      // By the account.
      (id) => del(`/v1/devices/${id}`, accountToken),
      // By itself.
      (_id, token) => del('/v1/devices/self', token),
    ]
    for (const revoke of revokes) {
      const gone = await t.device(accountToken, vaultId, 'stolen')
      const watching = await open(t.app, vaultId)
      const staying = await open(t.app, vaultId)
      opened.push(watching, staying)
      hello(watching, gone.deviceToken)
      hello(staying, keeper.deviceToken)
      await until(() => t.hub.sockets(vaultId) === 2, 'both sockets')

      const res = (await revoke(gone.deviceId, gone.deviceToken)) as { statusCode: number }
      expect(res.statusCode).toBe(204)
      await until(
        () => watching.socket.readyState === WebSocket.CLOSED,
        'the revoked socket to close'
      )
      expect(await watching.closed).toBe(4001)
      expect(t.hub.sockets(vaultId)).toBe(1)

      // The revoked device hears nothing more; the one that stays does.
      await put(t.app, keeper.deviceToken, 'after\n')
      await post(t.app, keeper.deviceToken, vaultId, [
        create(`After-${gone.deviceId}.md`, 'after\n'),
      ])
      await until(() => staying.frames.length > 0, 'a frame for the device that stays')
      expect(watching.frames).toEqual([])
      staying.socket.close()
      await staying.closed
      await until(() => t.hub.sockets(vaultId) === 0, 'the sockets to be forgotten')
    }
  })

  it('closes with 4001 a socket that says nothing within the hello timeout', async () => {
    const quick = await buildTestApp({ wsHelloTimeoutMs: 200 })
    try {
      await quick.app.listen({ port: 0 })
      const { accountToken: token } = await quick.account()
      const { vaultId } = await quick.vault(token)
      const silent = await open(quick.app, vaultId)
      const started = Date.now()
      expect(await silent.closed).toBe(4001)
      expect(Date.now() - started).toBeLessThan(1000)
      expect(quick.hub.sockets(vaultId)).toBe(0)

      // The deadline is for silence alone: a socket that greeted keeps its place.
      const device = (await quick.device(token, vaultId, 'quick')).deviceToken
      const greeted = await open(quick.app, vaultId)
      hello(greeted, device)
      await until(() => quick.hub.sockets(vaultId) === 1, 'the greeted socket')
      await wait(500)
      expect(greeted.socket.readyState).toBe(WebSocket.OPEN)

      await put(quick.app, device, 'quick\n')
      await post(quick.app, device, vaultId, [create('Quick.md', 'quick\n')])
      await wait(400)
      expect(greeted.frames).toEqual([{ type: 'seq', head_seq: 1 }])
      greeted.socket.close()
    } finally {
      await quick.close()
    }
  })
})
