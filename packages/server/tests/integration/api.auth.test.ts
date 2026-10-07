import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'

describe('auth routes', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  it('logs in, creates a vault, enrols a device, reads state', async () => {
    const { accountToken } = await t.account('a@x.io')
    const r = await api(t.app, accountToken).post('/v1/vaults', { name: 'Main' })
    expect(r.status).toBe(201)
    const vaultId = r.body.id
    const list = await api(t.app, accountToken).get('/v1/vaults')
    expect(list.body).toEqual([
      expect.objectContaining({ id: vaultId, name: 'Main', role: 'owner' }),
    ])
    const d = await api(t.app, accountToken).post('/v1/devices', {
      vault_id: vaultId,
      name: 'laptop',
      platform: 'desktop',
    })
    expect(d.status).toBe(201)
    const state = await api(t.app, d.body.device_token).get(`/v1/vaults/${vaultId}/state`)
    expect(state.status).toBe(200)
    expect(state.body.head_seq).toBe(0)
    expect(state.body.settings.conflict).toBe('merge')
    const patched = await api(t.app, d.body.device_token).patch(`/v1/vaults/${vaultId}/settings`, {
      conflict: 'conflict-file',
    })
    expect(patched.body.conflict).toBe('conflict-file')
    expect(patched.body.scripts_folder).toBe('Scripts')
  })
  it('answers 401 without a token and 403 for another vault', async () => {
    const { accountToken } = await t.account('b@x.io')
    const { vaultId } = await t.vault(accountToken)
    const { vaultId: other } = await t.vault(accountToken, 'Other')
    const { deviceToken } = await t.device(accountToken, vaultId)
    expect((await api(t.app).get(`/v1/vaults/${vaultId}/state`)).status).toBe(401)
    const r = await api(t.app, deviceToken).get(`/v1/vaults/${other}/state`)
    expect(r.status).toBe(403)
    expect(r.body).toEqual({
      error: { code: 'forbidden', message: expect.any(String), details: {} },
    })
  })
  it('rejects an account token on a device route and vice versa', async () => {
    const { accountToken } = await t.account('c@x.io')
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    expect((await api(t.app, accountToken).get(`/v1/vaults/${vaultId}/state`)).status).toBe(401)
    expect((await api(t.app, deviceToken).get('/v1/vaults')).status).toBe(401)
  })
  it('maps validation failures to invalid_request and unknown routes to not_found', async () => {
    const r = await api(t.app).post('/v1/auth/login', { email: 1 })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_request')
    expect((await api(t.app).get('/v1/nope')).body.error.code).toBe('not_found')
  })
  it('rate-limits login attempts', async () => {
    // Its own server, so the budget is the ten this test spends and no others.
    const fresh = await buildTestApp()
    try {
      for (let i = 0; i < 10; i++) {
        const attempt = await api(fresh.app).post('/v1/auth/login', {
          email: 'x@x.io',
          password: 'no',
        })
        expect(attempt.status).toBe(401)
      }
      const r = await api(fresh.app).post('/v1/auth/login', { email: 'x@x.io', password: 'no' })
      expect(r.status).toBe(429)
      expect(r.body.error.code).toBe('rate_limited')
    } finally {
      await fresh.close()
    }
  })
  it('counts logins by the forwarded address only where the proxy is trusted', async () => {
    const attempt = (app: TestApp['app'], i: number) =>
      api(app).post(
        '/v1/auth/login',
        { email: 'x@x.io', password: 'no' },
        { 'x-forwarded-for': `203.0.113.${i}` }
      )
    // The default: the header is anyone's to write, so eleven "clients" share one budget.
    const strict = await buildTestApp()
    try {
      for (let i = 0; i < 10; i++) expect((await attempt(strict.app, i)).status).toBe(401)
      const r = await attempt(strict.app, 10)
      expect(r.status).toBe(429)
      expect(r.body.error.code).toBe('rate_limited')
    } finally {
      await strict.close()
    }
    // Behind a trusted proxy each forwarded address is a client of its own.
    const trusting = await buildTestApp({ trustProxy: true })
    try {
      for (let i = 0; i < 11; i++) expect((await attempt(trusting.app, i)).status).toBe(401)
    } finally {
      await trusting.close()
    }
    // A list names the proxies: the test client's own address is on it, so the header counts...
    const listed = await buildTestApp({ trustProxy: ['127.0.0.1'] })
    try {
      for (let i = 0; i < 11; i++) expect((await attempt(listed.app, i)).status).toBe(401)
    } finally {
      await listed.close()
    }
    // ...and off it, the header is ignored as before.
    const elsewhere = await buildTestApp({ trustProxy: ['10.0.0.1'] })
    try {
      for (let i = 0; i < 10; i++) expect((await attempt(elsewhere.app, i)).status).toBe(401)
      expect((await attempt(elsewhere.app, 10)).status).toBe(429)
    } finally {
      await elsewhere.close()
    }
  })
})
