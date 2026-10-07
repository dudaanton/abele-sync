import { Device, type DeviceOptions } from './device.js'
import { serverHarness, type Harness } from './harness.js'
import { api } from '@abele/sync-server/tests/helpers/client.js'

/** A fresh server/account/vault per corner case, with isolated synthetic storage. */
export async function adversarial(options: Parameters<typeof serverHarness>[0] = {}) {
  const h = await serverHarness(options)
  const account = await h.account()
  const { vaultId } = await h.vault(account.accountToken, 'adversarial')
  const devices: Device[] = []
  async function device(name: string, opts: DeviceOptions = {}) {
    const { deviceToken } = await h.device(account.accountToken, vaultId, name)
    const d = new Device(h, vaultId, deviceToken, name, opts)
    devices.push(d)
    return d
  }
  return {
    h,
    account,
    vaultId,
    device,
    async settings(token: string, patch: Record<string, unknown>) {
      const r = await api(h.app, token).patch(`/v1/vaults/${vaultId}/settings`, patch)
      if (r.status !== 200) throw new Error(`settings: ${r.status} ${r.raw}`)
    },
    revive(d: Device, opts: DeviceOptions = {}) {
      const next = new Device(h, vaultId, d.deviceToken, d.name, {
        fs: d.fs,
        state: d.state,
        ...opts,
      })
      devices.push(next)
      return next
    },
    async close() {
      for (const d of devices) await d.engine.stop()
      await h.close()
    },
  }
}

export type Adversarial = Awaited<ReturnType<typeof adversarial>>
export { api }
export type { Harness }
