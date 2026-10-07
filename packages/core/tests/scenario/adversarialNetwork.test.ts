import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adversarial, type Adversarial } from '../helpers/adversarial.js'
import { converge } from '../helpers/device.js'

let t: Adversarial
beforeEach(async () => {
  t = await adversarial({ partBytes: 16, simpleUploadBytes: 32 })
  const client = t.h.clientFor
  t.h.clientFor = (token, vault, options) =>
    client(token, vault, { simpleUploadBytes: 32, ...options })
})
afterEach(async () => {
  await t.close()
})

const requests: Array<[string, string, RegExp]> = [
  ['state', 'GET', /\/state$/],
  ['manifest', 'GET', /\/manifest/],
  ['changes', 'GET', /\/changes/],
  ['head', 'HEAD', /\/blobs\/[^/]+$/],
  ['put', 'PUT', /\/blobs\/[^/]+$/],
  ['begin', 'POST', /\/upload$/],
  ['part', 'PUT', /\/upload\/[^/]+\/1$/],
  ['complete', 'POST', /\/complete$/],
  ['commit', 'POST', /\/commit$/],
  ['download', 'GET', /\/blobs\/[^/]+$/],
]

describe('Adversarial: transport faults through the real HTTP codec and server', () => {
  for (const [name, method, path] of requests)
    for (const side of ['before', 'after']) {
      it(`${name}: connection lost ${side} server handling, restart loses no bytes`, async () => {
        const a = await t.device('source')
        await a.write('remote.md', 'remote bytes')
        await a.sync()
        let armed = false,
          hits = 0
        const transport: typeof fetch = async (input, init) => {
          if (armed && init?.method === method && path.test(String(input))) {
            armed = false
            hits++
            if (side === 'after') await t.h.fetch(input, init)
            throw new TypeError('adversarial network drop')
          }
          return t.h.fetch(input, init)
        }
        const b = await t.device('faulted', { fetch: transport })
        if (name !== 'manifest' && name !== 'download') await b.sync()
        await b.write('small.md', 'small bytes')
        await b.write('large.bin', 'part payload '.repeat(8))
        armed = true
        await expect(b.sync()).rejects.toThrow()
        expect(hits).toBe(1)
        const next = t.revive(b)
        await converge(a, next)
        expect(await next.text('remote.md')).toBe('remote bytes')
        expect(await next.text('small.md')).toBe('small bytes')
        expect(await next.text('large.bin')).toBe('part payload '.repeat(8))
        expect(await next.state.getJournal()).toBeNull()
        const seq = (await next.client.state()).head_seq
        await converge(a, next)
        expect((await next.client.state()).head_seq).toBe(seq)
        for (const entry of (await next.client.manifest(null)).items) {
          expect(await next.client.versions(entry.file_id)).toHaveLength(1)
        }
      })
    }

  for (const route of ['put', 'commit']) {
    it(`429 on ${route} keeps journal and retries safely without changing bytes`, async () => {
      let reject = true
      const transport: typeof fetch = async (input, init) => {
        if (
          reject &&
          (route === 'put' ? init?.method === 'PUT' : String(input).endsWith('/commit'))
        ) {
          reject = false
          return new Response(
            JSON.stringify({ error: { code: 'rate_limited', message: 'test limit', details: {} } }),
            { status: 429, headers: { 'retry-after': '1' } }
          )
        }
        return t.h.fetch(input, init)
      }
      const a = await t.device('limited', { fetch: transport })
      await a.write('note.md', 'unchanged bytes')
      await expect(a.sync()).rejects.toThrow('test limit')
      expect(await a.state.getJournal()).not.toBeNull()
      await a.sync()
      expect(await a.state.getJournal()).toBeNull()
      expect((await a.client.manifest(null)).items).toHaveLength(1)
    })
  }

  // BUG: A3 — upload IDs/confirmed parts do not survive a journal restart.
  it('A3 resumes acknowledged multipart parts rather than uploading them again', async () => {
    let drop = true
    const parts: number[] = []
    const transport: typeof fetch = async (input, init) => {
      const match = /\/upload\/[^/]+\/(\d+)$/.exec(String(input))
      if (init?.method === 'PUT' && match) {
        const index = Number(match[1])
        if (index === 2 && drop) {
          drop = false
          throw new TypeError('drop')
        }
        parts.push(index)
      }
      return t.h.fetch(input, init)
    }
    const a = await t.device('multipart', { fetch: transport })
    await a.write('large.bin', 'x'.repeat(64))
    await expect(a.sync()).rejects.toThrow()
    expect(parts).toEqual([0, 1])
    const next = t.revive(a, { fetch: transport })
    await next.sync()
    expect((await next.client.manifest(null)).items).toHaveLength(1)
    expect(parts).toEqual([0, 1, 2, 3])
  })

  it('flapping and delayed replies retain both sides of offline edits', async () => {
    const a = await t.device('a')
    let drop = false,
      requests = 0
    const b = await t.device('b', {
      fetch: async (input, init) => {
        requests++
        if (drop && requests % 2 === 0) throw new TypeError('flapping')
        await new Promise<void>((resolve) => setImmediate(resolve))
        return t.h.fetch(input, init)
      },
    })
    await a.write('note.md', 'top\nmiddle\nbottom\n')
    await converge(a, b)
    await a.write('note.md', 'A\nmiddle\nbottom\n')
    await b.write('note.md', 'top\nmiddle\nB\n')
    await a.sync()
    drop = true
    for (let i = 0; i < 4; i++) await expect(b.sync()).rejects.toThrow()
    drop = false
    await converge(a, b)
    expect(await a.text('note.md')).toBe('A\nmiddle\nB\n')
  })
})
