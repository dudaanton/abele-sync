import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authenticateDevice } from '../../src/auth/devices.js'
import { authenticateAccount } from '../../src/auth/accounts.js'
import { hashToken } from '../../src/auth/hash.js'
import { api } from '../helpers/client.js'
import { buildTestApp, TEST_TOKEN_PEPPER, type TestApp } from '../helpers/testApp.js'

let t: TestApp,
  accountId: string,
  accountToken: string,
  deviceId: string,
  token: string,
  vault: string
const scoped = `absk_${'x'.repeat(43)}`
beforeEach(async () => {
  t = await buildTestApp()
  ;({ accountId, accountToken } = await t.account())
  vault = (await t.vault(accountToken)).vaultId
  ;({ deviceId, deviceToken: token } = await t.device(accountToken, vault))
})
afterEach(async () => {
  await t.close()
})

describe('v4 feature and facet fences', () => {
  it('reports scoped disabled with no configurable early activation and no-store capabilities', async () => {
    const response = await api(t.app).get('/v1/capabilities')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ protocol_version: 1, device: true, scoped: { enabled: false } })
    const raw = await t.app.inject({ url: '/v1/capabilities' })
    expect(raw.headers['cache-control']).toBe('no-store')
  })
  it('gates scoped sync, owner management, invitation and publication namespaces before body parsing', async () => {
    const paths = [
      '/v1/scoped/grants/g/commit',
      '/v1/scoped/grants/g/manifest',
      `/v1/scoped/vaults/${vault}/grants/g/files/f/versions`,
      `/v1/scoped/vaults/${vault}/grants/g/files/f/versions/v`,
      `/v1/scoped/vaults/${vault}/grants/g/trash`,
      `/v1/scoped/vaults/${vault}/grants/g/uploads/${'a'.repeat(64)}/begin`,
      `/v1/scoped/vaults/${vault}/grants/g/uploads/${'a'.repeat(64)}/id/0`,
      `/v1/scoped/vaults/${vault}/grants/g/uploads/${'a'.repeat(64)}/id/complete`,
      `/v1/vaults/${vault}/grants`,
      `/v1/vaults/${vault}/grants/g/invitations`,
      `/v1/vaults/${vault}/grants/g/extras`,
      '/v1/grants',
      '/v1/invitations/accept',
    ]
    for (const url of paths) {
      for (const credential of [accountToken, token, scoped]) {
        const response = await t.app.inject({
          method: 'POST',
          url,
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
            'x-abele-scoped-version': '4',
          },
          payload: '{bad json',
        })
        expect(response.statusCode, url).toBe(503)
        expect(response.json().error.code).toBe('scoped_unavailable')
        expect(response.headers['cache-control']).toBe('no-store')
      }
    }
  })
  it('rejects old/missing scoped versions before a future scoped handler can run', async () => {
    for (const version of [undefined, '1', '3', '04', '4,4']) {
      const response = await t.app.inject({
        url: '/v1/scoped/grants/g/state',
        headers: version === undefined ? {} : { 'x-abele-scoped-version': version },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.code).toBe('unsupported_scoped_protocol')
    }
    const current = await t.app.inject({
      url: '/v1/scoped/grants/g/state',
      headers: { 'x-abele-scoped-version': '4' },
    })
    expect(current.statusCode).toBe(503)
  })
  it('never authenticates scoped bytes as a personal device, even if a legacy row holds that digest', async () => {
    await t.db
      .updateTable('devices')
      .set({ token_hash: hashToken(TEST_TOKEN_PEPPER, scoped) })
      .where('id', '=', deviceId)
      .execute()
    const deps = { db: t.db, pepper: TEST_TOKEN_PEPPER, accountTokenTtlMs: 60000 }
    await expect(authenticateDevice(deps, scoped)).rejects.toMatchObject({ code: 'unauthorized' })
    for (const path of [
      `/v1/vaults/${vault}/state`,
      `/v1/vaults/${vault}/manifest`,
      `/v1/vaults/${vault}/devices`,
      '/v1/blobs/' + 'a'.repeat(64),
    ]) {
      expect((await api(t.app, scoped).get(path)).status).toBe(401)
    }
    const revoke = await t.app.inject({
      method: 'DELETE',
      url: '/v1/devices/self',
      headers: { authorization: `Bearer ${scoped}` },
    })
    expect(revoke.statusCode).toBe(401)
  })
  it('never authenticates scoped bytes as an account even if its owner account has that digest', async () => {
    await t.db
      .insertInto('account_tokens')
      .values({
        token_hash: hashToken(TEST_TOKEN_PEPPER, scoped),
        account_id: accountId,
        expires_at: '2099-01-01T00:00:00.000Z',
      })
      .execute()
    await expect(
      authenticateAccount({ db: t.db, pepper: TEST_TOKEN_PEPPER, accountTokenTtlMs: 60000 }, scoped)
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })
})
