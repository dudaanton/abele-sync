import { DeviceInfoSchema } from '@abele/sync-protocol'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Dialect } from '../../src/db/connect.js'
import { api } from '../helpers/client.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

/**
 * The vault's own device list, on a device token: what a device may see of the
 * others beside it, and which of them it may cut off. Run on both databases,
 * because the revoke is a guarded update whose row count each dialect reports
 * its own way.
 */
function vaultDeviceRoutes(dialect: Dialect): void {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp({ dialect })
  })
  afterAll(async () => {
    await t.close()
  })

  /** An account with one vault and the devices named, in that order. */
  async function setup(...names: string[]) {
    const { accountId, accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const devices = []
    for (const name of names) devices.push(await t.device(accountToken, vaultId, name))
    return { accountId, accountToken, vaultId, devices }
  }

  /** A second account let into `vaultId`, with a device of its own there. */
  async function stranger(vaultId: string) {
    const { accountId, accountToken } = await t.account()
    await t.db
      .insertInto('vault_members')
      .values({ vault_id: vaultId, account_id: accountId, role: 'member' })
      .execute()
    return t.device(accountToken, vaultId, 'stranger')
  }

  it("lists this account's live devices on this vault, itself included, and nothing else", async () => {
    const { accountToken, vaultId, devices } = await setup('laptop', 'phone', 'gone')
    const [laptop, phone, gone] = devices
    // Another vault of the same account, and another account on this vault.
    const { vaultId: otherVault } = await t.vault(accountToken, 'Other')
    await t.device(accountToken, otherVault, 'elsewhere')
    await stranger(vaultId)
    await api(t.app, gone!.deviceToken).del('/v1/devices/self')

    const r = await api(t.app, laptop!.deviceToken).get(`/v1/vaults/${vaultId}/devices`)
    expect(r.status).toBe(200)
    const listed = DeviceInfoSchema.array().parse(r.body)
    // Oldest first; two enrolled in one millisecond may come either way.
    expect(listed.map((d) => [d.id, d.name]).sort()).toEqual(
      [
        [laptop!.deviceId, 'laptop'],
        [phone!.deviceId, 'phone'],
      ].sort()
    )
    expect(listed.find((d) => d.id === laptop!.deviceId)).toEqual(
      expect.objectContaining({ platform: 'desktop', vault_id: vaultId, enrolled_by: null })
    )
    // The listing is what the account route shows, and never a token or its hash.
    expect(r.raw).not.toContain(laptop!.deviceToken)
    expect(r.raw).not.toContain(phone!.deviceToken)
    expect(r.raw).not.toMatch(/token/i)
  })

  it('refuses another vault in the path, an account token, and no token', async () => {
    const { accountToken, vaultId, devices } = await setup('laptop')
    const { vaultId: otherVault } = await t.vault(accountToken, 'Other')
    const token = devices[0]!.deviceToken

    const elsewhere = await api(t.app, token).get(`/v1/vaults/${otherVault}/devices`)
    expect(elsewhere.status).toBe(403)
    expect((await api(t.app, accountToken).get(`/v1/vaults/${vaultId}/devices`)).status).toBe(401)
    expect((await api(t.app).get(`/v1/vaults/${vaultId}/devices`)).status).toBe(401)
    const cut = await api(t.app, token).del(
      `/v1/vaults/${otherVault}/devices/${devices[0]!.deviceId}`
    )
    expect(cut.status).toBe(403)
  })

  it('revokes another device of this account on this vault, and its token stops working', async () => {
    const { vaultId, devices } = await setup('laptop', 'phone')
    const [laptop, phone] = devices

    const r = await api(t.app, laptop!.deviceToken).del(
      `/v1/vaults/${vaultId}/devices/${phone!.deviceId}`
    )
    expect(r.status).toBe(204)
    expect(r.raw).toBe('')
    expect((await api(t.app, phone!.deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(
      401
    )
    expect((await api(t.app, laptop!.deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(
      200
    )
    const listed = (await api(t.app, laptop!.deviceToken).get(`/v1/vaults/${vaultId}/devices`))
      .body as { id: string }[]
    expect(listed.map((d) => d.id)).toEqual([laptop!.deviceId])
  })

  it('answers a revoke of a device already revoked as done, and leaves its revoke time', async () => {
    const { vaultId, devices } = await setup('laptop', 'phone')
    const [laptop, phone] = devices
    const path = `/v1/vaults/${vaultId}/devices/${phone!.deviceId}`

    expect((await api(t.app, laptop!.deviceToken).del(path)).status).toBe(204)
    const first = await t.db
      .selectFrom('devices')
      .select('revoked_at')
      .where('id', '=', phone!.deviceId)
      .executeTakeFirstOrThrow()
    expect(first.revoked_at).not.toBeNull()
    // A client that never heard the first answer asks again and hears the same.
    expect((await api(t.app, laptop!.deviceToken).del(path)).status).toBe(204)
    const second = await t.db
      .selectFrom('devices')
      .select('revoked_at')
      .where('id', '=', phone!.deviceId)
      .executeTakeFirstOrThrow()
    expect(second.revoked_at).toBe(first.revoked_at)
  })

  it('cannot reach a device of another vault or another account, which stays live', async () => {
    const { accountToken, vaultId, devices } = await setup('laptop')
    const laptop = devices[0]!
    const { vaultId: otherVault } = await t.vault(accountToken, 'Other')
    const elsewhere = await t.device(accountToken, otherVault, 'elsewhere')
    const theirs = await stranger(vaultId)

    for (const target of [elsewhere, theirs]) {
      const r = await api(t.app, laptop.deviceToken).del(
        `/v1/vaults/${vaultId}/devices/${target.deviceId}`
      )
      // To this device they do not exist, so nothing tells it they do.
      expect(r.status).toBe(404)
      expect(r.body.error.code).toBe('not_found')
    }
    const none = await api(t.app, laptop.deviceToken).del(`/v1/vaults/${vaultId}/devices/nope`)
    expect(none.status).toBe(404)

    expect(
      (await api(t.app, elsewhere.deviceToken).get(`/v1/vaults/${otherVault}/state`)).status
    ).toBe(200)
    expect((await api(t.app, theirs.deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(
      200
    )
  })

  it('refuses a device revoking itself here, and it stays live', async () => {
    const { vaultId, devices } = await setup('laptop')
    const laptop = devices[0]!

    const r = await api(t.app, laptop.deviceToken).del(
      `/v1/vaults/${vaultId}/devices/${laptop.deviceId}`
    )
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('conflict')
    expect(r.body.error.message).toContain('/v1/devices/self')
    expect((await api(t.app, laptop.deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(
      200
    )
  })

  it('refuses the eleventh revoke a device asks for inside a minute, counted per token', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `d${i}`)
    const { vaultId, devices } = await setup('laptop', 'other', ...names)
    const [laptop, other, ...targets] = devices
    const cut = (token: string, id: string) =>
      api(t.app, token).del(`/v1/vaults/${vaultId}/devices/${id}`)

    for (let i = 0; i < 10; i++)
      expect((await cut(laptop!.deviceToken, targets[i]!.deviceId)).status).toBe(204)
    const eleventh = await cut(laptop!.deviceToken, targets[10]!.deviceId)
    expect(eleventh.status).toBe(429)
    expect(eleventh.body.error.code).toBe('rate_limited')
    // The count is the token's: another device on the vault is not held up by it.
    expect((await cut(other!.deviceToken, targets[11]!.deviceId)).status).toBe(204)
  })

  it('refuses the sixty-first listing a device asks for inside a minute', async () => {
    const { vaultId, devices } = await setup('laptop')
    const list = () => api(t.app, devices[0]!.deviceToken).get(`/v1/vaults/${vaultId}/devices`)
    for (let i = 0; i < 60; i++) expect((await list()).status).toBe(200)
    const r = await list()
    expect(r.status).toBe(429)
    expect(r.body.error.code).toBe('rate_limited')
  })
}

describe('vault device routes', () => vaultDeviceRoutes('sqlite'))
describe.skipIf(!hasPgTestDb)('vault device routes on postgres', () => vaultDeviceRoutes('pg'))
