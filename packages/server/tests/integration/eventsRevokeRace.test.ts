import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { DeviceIdentity } from '../../src/auth/devices.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

/**
 * A device revoked while its event socket is still in the handshake:
 * the revoke's hang-up runs while the token is being checked, finds no socket to hang up, and the
 * socket is attached a moment later. The handshake asks once more after it attaches.
 */

const hook = vi.hoisted(() => ({
  /** Run once, between the token being found good and the handshake going on. */
  next: null as ((device: DeviceIdentity) => Promise<void>) | null,
}))

vi.mock('../../src/auth/devices.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/auth/devices.js')>()
  return {
    ...real,
    authenticateDevice: async (...args: Parameters<typeof real.authenticateDevice>) => {
      const device = await real.authenticateDevice(...args)
      const run = hook.next
      hook.next = null
      if (run !== null) await run(device)
      return device
    },
  }
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(10)
  }
}

describe('event socket', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await buildTestApp()
    await t.app.listen({ port: 0 })
  })
  afterAll(async () => {
    await t.close()
  })

  it('hangs up a socket whose device was revoked while its hello was being checked', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken, 'revoked-mid-hello')
    const gone = await t.device(accountToken, vaultId, 'stolen')

    const { port } = t.app.server.address() as AddressInfo
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/vaults/${vaultId}/events`)
    socket.on('error', () => {})
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)))
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    let revoked = 0
    hook.next = async (device) => {
      const res = await t.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${device.deviceId}`,
        headers: { authorization: `Bearer ${accountToken}` },
      })
      revoked = res.statusCode
    }
    socket.send(JSON.stringify({ token: gone.deviceToken }))

    await until(() => socket.readyState === WebSocket.CLOSED, 'the revoked socket to close')
    expect(revoked).toBe(204)
    expect(await closed).toBe(4001)
    await until(() => t.hub.sockets(vaultId) === 0, 'the socket to be forgotten')
  })
})
