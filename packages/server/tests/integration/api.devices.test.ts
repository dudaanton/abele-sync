import { DeviceInfoSchema, EnrolDeviceResponseSchema } from '@abele/sync-protocol'
import Fastify from 'fastify'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { errorHandler } from '../../src/api/errors.js'
import { deviceOf, requireAnyDevice } from '../../src/auth/hooks.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { buildTestApp, TEST_TOKEN_PEPPER, type TestApp } from '../helpers/testApp.js'

/** Device tokens never expire, so the account token's lifetime is irrelevant here. */
const HOUR_MS = 60 * 60 * 1000

describe('device routes', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  it('lists a device, revokes it, and stops honouring its token', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceId, deviceToken } = await t.device(accountToken, vaultId, 'laptop')

    const list = await api(t.app, accountToken).get('/v1/devices')
    expect(list.status).toBe(200)
    expect(DeviceInfoSchema.array().parse(list.body)).toEqual([
      expect.objectContaining({
        id: deviceId,
        name: 'laptop',
        platform: 'desktop',
        vault_id: vaultId,
      }),
    ])
    expect((await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(200)

    const revoked = await api(t.app, accountToken).del(`/v1/devices/${deviceId}`)
    expect(revoked.status).toBe(204)
    expect(revoked.raw).toBe('')
    expect((await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(401)
    expect((await api(t.app, accountToken).get('/v1/devices')).body).toEqual([])
  })

  it('answers not_found for a device the account never enrolled', async () => {
    const { accountToken } = await t.account()
    const r = await api(t.app, accountToken).del('/v1/devices/no-such-device')
    expect(r.status).toBe(404)
    expect(r.body.error.code).toBe('not_found')
  })

  it('takes a device token on a route with no vault in its path', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)

    // Blob routes authenticate this way: a device, any vault.
    const probe = Fastify({ logger: false })
    probe.decorateRequest('device', null)
    probe.setErrorHandler(errorHandler)
    probe.get(
      '/probe',
      {
        preHandler: requireAnyDevice({
          db: t.db,
          pepper: TEST_TOKEN_PEPPER,
          accountTokenTtlMs: HOUR_MS,
        }),
      },
      async (request) => ({ vault_id: deviceOf(request).vaultId })
    )
    await probe.ready()
    try {
      const ok = await api(probe, deviceToken).get('/probe')
      expect(ok.status).toBe(200)
      expect(ok.body.vault_id).toBe(vaultId)
      expect((await api(probe, accountToken).get('/probe')).status).toBe(401)
      expect((await api(probe).get('/probe')).status).toBe(401)
    } finally {
      await probe.close()
    }
  })
  it('lets a device revoke itself, after which its token is refused', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceId, deviceToken } = await t.device(accountToken, vaultId, 'phone')
    const other = await t.device(accountToken, vaultId, 'laptop')

    const r = await api(t.app, deviceToken).del('/v1/devices/self')
    expect(r.status).toBe(204)
    expect(r.raw).toBe('')

    expect((await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(401)
    // Gone already: the hook refuses the token, which a client reads as "already revoked".
    expect((await api(t.app, deviceToken).del('/v1/devices/self')).status).toBe(401)
    // Only that device: its sibling on the same vault still syncs.
    expect((await api(t.app, other.deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(
      200
    )
    const listed = (await api(t.app, accountToken).get('/v1/devices')).body as { id: string }[]
    expect(listed.map((d) => d.id)).toEqual([other.deviceId])
    expect(listed.map((d) => d.id)).not.toContain(deviceId)
  })

  it('refuses an account token on the device routes, and no token at all', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    await t.device(accountToken, vaultId)

    expect((await api(t.app, accountToken).del('/v1/devices/self')).status).toBe(401)
    expect((await api(t.app).del('/v1/devices/self')).status).toBe(401)
    const sibling = await api(t.app, accountToken).post('/v1/devices/self/siblings', {
      name: 'x',
      platform: 'mobile',
    })
    expect(sibling.status).toBe(401)
    // The account's list is untouched by either attempt.
    expect((await api(t.app, accountToken).get('/v1/devices')).body).toHaveLength(1)
  })

  it('keeps DELETE /v1/devices/:id an account route beside /self', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceId, deviceToken } = await t.device(accountToken, vaultId)

    // A device token cannot reach the account route by naming its own id.
    expect((await api(t.app, deviceToken).del(`/v1/devices/${deviceId}`)).status).toBe(401)
    expect((await api(t.app, accountToken).del(`/v1/devices/${deviceId}`)).status).toBe(204)
    expect((await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(401)
  })

  it('enrols a sibling on the same vault and account, which syncs as a device of its own', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const parent = await t.device(accountToken, vaultId, 'laptop')

    const r = await api(t.app, parent.deviceToken).post('/v1/devices/self/siblings', {
      name: 'phone',
      platform: 'mobile',
    })
    expect(r.status).toBe(201)
    const sibling = EnrolDeviceResponseSchema.parse(r.body)
    expect(sibling.device_id).not.toBe(parent.deviceId)
    expect(sibling.device_token).not.toBe(parent.deviceToken)
    expect(sibling.device_token.startsWith('absd_')).toBe(true)

    const listed = DeviceInfoSchema.array().parse(
      (await api(t.app, accountToken).get('/v1/devices')).body
    )
    expect(listed).toEqual([
      expect.objectContaining({ id: parent.deviceId, vault_id: vaultId, enrolled_by: null }),
      expect.objectContaining({
        id: sibling.device_id,
        name: 'phone',
        platform: 'mobile',
        vault_id: vaultId,
        enrolled_by: parent.deviceId,
      }),
    ])

    await putBlob(t.app, sibling.device_token, 'from the sibling\n')
    const done = await commit(t.app, sibling.device_token, vaultId, [
      create('Sibling.md', 'from the sibling\n'),
    ])
    expect(done.results[0].status).toBe('applied')

    // Revoking the sibling leaves the device that minted it alone.
    expect((await api(t.app, sibling.device_token).del('/v1/devices/self')).status).toBe(204)
    expect((await api(t.app, parent.deviceToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(
      200
    )
  })

  it('refuses a sibling to a revoked device, and a malformed request', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)

    const bad = await api(t.app, deviceToken).post('/v1/devices/self/siblings', {
      name: '',
      platform: 'toaster',
    })
    expect(bad.status).toBe(400)

    await api(t.app, deviceToken).del('/v1/devices/self')
    const r = await api(t.app, deviceToken).post('/v1/devices/self/siblings', {
      name: 'phone',
      platform: 'mobile',
    })
    expect(r.status).toBe(401)
    expect((await api(t.app, accountToken).get('/v1/devices')).body).toEqual([])
  })

  it('refuses the eleventh sibling a device asks for inside a minute', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const ask = () =>
      api(t.app, deviceToken).post('/v1/devices/self/siblings', { name: 'n', platform: 'desktop' })

    for (let i = 0; i < 10; i++) expect((await ask()).status).toBe(201)
    const eleventh = await ask()
    expect(eleventh.status).toBe(429)
    expect(eleventh.body.error.code).toBe('rate_limited')
    // The limit is the token's: another device of the same vault is not held up by it.
    const other = await t.device(accountToken, vaultId)
    const theirs = await api(t.app, other.deviceToken).post('/v1/devices/self/siblings', {
      name: 'n',
      platform: 'desktop',
    })
    expect(theirs.status).toBe(201)
  })

  it('counts one token as one, however its header is spelled', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const ask = (authorization: string) =>
      api(t.app).post(
        '/v1/devices/self/siblings',
        { name: 'n', platform: 'desktop' },
        { authorization }
      )

    for (let i = 0; i < 10; i++) expect((await ask(`Bearer ${deviceToken}`)).status).toBe(201)
    // The auth hook takes every one of these as the same token, so the limit does too.
    for (const spelling of [
      `bearer  ${deviceToken}`,
      `BEARER ${deviceToken}`,
      `Bearer    ${deviceToken}  `,
    ]) {
      const r = await ask(spelling)
      expect(r.status).toBe(429)
      expect(r.body.error.code).toBe('rate_limited')
    }
  })
})
