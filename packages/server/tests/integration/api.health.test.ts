import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'

describe('health route', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  it('answers ok without a token, so a container probe needs no credentials', async () => {
    const r = await api(t.app).get('/healthz')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })
  it('is a GET: anything else is not a route', async () => {
    expect((await api(t.app).post('/healthz', {})).status).toBe(404)
  })
})
