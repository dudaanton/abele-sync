import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { create, seed } from '../helpers/seed.js'

/**
 * A hold filed by an earlier process is on the status from the start: a device relaunched paused or offline never reaches the delete check, and its
 * host would otherwise show nothing although `heldDeletes()` lists them.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

const name = (k: number): string => `notes/n${String(k).padStart(3, '0')}.md`

/** A vault of 40 notes synced down to a device, which then deletes 20 and has them held. */
async function holding(label: string): Promise<{ vaultId: string; d: Device }> {
  const { vaultId } = await h.vault(account, label)
  const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
  const seeder = h.clientFor(seederToken, vaultId)
  const ops = []
  for (let k = 0; k < 40; k++) ops.push(await create(seeder, name(k), `note ${k}\n`))
  await seed(seeder, ops)
  const { deviceToken } = await h.device(account, vaultId, 'laptop')
  const d = new Device(h, vaultId, deviceToken, 'laptop')
  await d.sync()
  for (let k = 0; k < 20; k++) await d.rm(name(k))
  await d.sync()
  expect(d.engine.status.heldDeletes).toBe(20)
  return { vaultId, d }
}

const unreachable: typeof fetch = () => Promise.reject(new TypeError('fetch failed'))

describe('a hold filed before a restart', () => {
  it('is on the status of an engine started paused, without asking the server', async () => {
    const { vaultId, d } = await holding('hold-restart-paused')
    let asked = 0
    const counting: typeof fetch = (input, init) => {
      asked++
      return h.fetch(input, init)
    }
    const again = new Device(h, vaultId, d.deviceToken, 'laptop', {
      fs: d.fs,
      state: d.state,
      fetch: counting,
    })
    again.engine.pause()
    again.engine.start()
    await vi.waitFor(() => expect(again.engine.status.heldDeletes).toBe(20))
    expect(again.engine.status.state).toBe('paused')
    expect(asked).toBe(0)

    // Resuming runs the check again, which holds the same deletes.
    again.engine.resume()
    await vi.waitFor(() => expect(again.engine.status.state).toBe('idle'))
    expect(again.engine.status.heldDeletes).toBe(20)
    again.engine.pause()
    expect(again.engine.status.heldDeletes).toBe(20)
    await again.engine.stop()
  })

  it('is on the status of an engine that cannot reach the server', async () => {
    const { vaultId, d } = await holding('hold-restart-offline')
    const again = new Device(h, vaultId, d.deviceToken, 'laptop', {
      fs: d.fs,
      state: d.state,
      fetch: unreachable,
    })
    again.engine.start()
    await vi.waitFor(() => expect(again.engine.status.state).toBe('offline'))
    expect(again.engine.status.heldDeletes).toBe(20)
    await again.engine.stop()
  })
})
