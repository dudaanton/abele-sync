import { readFile, writeFile } from 'node:fs/promises'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { api } from '../helpers/client.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

describe('error mapping', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  it('refuses a JSON body that is not an object', async () => {
    const array = await api(t.app).post('/v1/auth/login', [1, 2, 3])
    expect(array.status).toBe(400)
    expect(array.body.error.code).toBe('invalid_request')
    expect(Array.isArray(array.body.error.details.issues)).toBe(true)

    const nothing = await api(t.app).raw({
      method: 'POST',
      url: '/v1/auth/login',
      payload: 'null',
      headers: JSON_HEADERS,
    })
    expect(nothing.status).toBe(400)
    expect(nothing.body.error.code).toBe('invalid_request')
  })

  it('refuses a body it cannot parse at all', async () => {
    const r = await api(t.app).raw({
      method: 'POST',
      url: '/v1/auth/login',
      payload: '{not json',
      headers: JSON_HEADERS,
    })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_request')
  })

  it('answers too_large for a body over the limit', async () => {
    const small = await buildTestApp({ simpleUploadBytes: 100, partBytes: 100 })
    try {
      const r = await api(small.app).raw({
        method: 'POST',
        url: '/v1/auth/login',
        payload: JSON.stringify({ email: 'a@x.io', password: 'x'.repeat(8192) }),
        headers: JSON_HEADERS,
      })
      expect(r.status).toBe(413)
      expect(r.body.error.code).toBe('too_large')
    } finally {
      await small.close()
    }
  })

  it('hides settings it cannot make sense of behind internal, storing nothing in the answer', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    // Valid JSON, but not settings: the caller did nothing wrong, so it is not their error.
    await t.db
      .updateTable('vaults')
      .set({ settings: JSON.stringify({ conflict: 'sometimes', scripts_folder: 42 }) })
      .where('id', '=', vaultId)
      .execute()

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/state`)
      expect(r.status).toBe(500)
      expect(r.body).toEqual({
        error: { code: 'internal', message: 'internal error', details: {} },
      })
      expect(r.raw).not.toContain('sometimes')
      expect(r.raw).not.toContain('scripts_folder')
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })

  it('says nothing about a blob it cannot open, not even its name', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const bytes = Buffer.from('bytes that will be tampered with')
    const sha = await putBlob(t.app, deviceToken, bytes)
    await commit(t.app, deviceToken, vaultId, [create('T.md', bytes)])
    const get = () => api(t.app, deviceToken).raw({ method: 'GET', url: `/v1/blobs/${sha}` })
    expect((await get()).status).toBe(200)

    const path = t.store.pathFor(sha)
    const envelope = await readFile(path)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A flipped byte in the tag: the bytes changed under the server, or the key is wrong.
      const flipped = Buffer.from(envelope)
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff
      await writeFile(path, flipped)
      const r = await get()
      expect(r.status).toBe(500)
      expect(r.body).toEqual({
        error: { code: 'internal', message: 'internal error', details: {} },
      })
      expect(r.raw).not.toContain(sha)
      expect(r.raw).not.toContain('decrypt')
      // The log is where the name goes.
      expect(logged).toHaveBeenCalledOnce()
      expect(String(logged.mock.calls[0]?.[1])).toContain(sha)

      // A file that is not an envelope at all: the same bare answer.
      await writeFile(path, 'not an envelope this server wrote')
      const junk = await get()
      expect(junk.status).toBe(500)
      expect(junk.body).toEqual({
        error: { code: 'internal', message: 'internal error', details: {} },
      })
      expect(junk.raw).not.toContain(sha)
      expect(junk.raw).not.toContain('envelope')
    } finally {
      logged.mockRestore()
      await writeFile(path, envelope)
    }
    expect((await get()).status).toBe(200)
  })

  it('hides an unexpected failure behind internal and keeps the stack to itself', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    // A settings column no parser can read: a fault of the server's own making.
    await t.db
      .updateTable('vaults')
      .set({ settings: '{not json' })
      .where('id', '=', vaultId)
      .execute()

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/state`)
      expect(r.status).toBe(500)
      expect(r.body).toEqual({
        error: { code: 'internal', message: 'internal error', details: {} },
      })
      expect(r.raw).not.toContain('SyntaxError')
      expect(r.raw).not.toMatch(/ at /)
      expect(logged).toHaveBeenCalledOnce()
    } finally {
      logged.mockRestore()
    }
  })
})
