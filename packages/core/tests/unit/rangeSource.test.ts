import { expect, it, vi } from 'vitest'
import { Http } from '../../src/http.js'
import { fingerprintSource } from '../../src/streaming.js'
import { sha256 } from '../../src/hash.js'

it.each([0, 1])('reads a %i-byte immutable version with an exact inclusive range', async (size) => {
  const requests: string[] = []
  const bytes = new Uint8Array(size).fill(7)
  const http = new Http({
    baseUrl: 'https://test',
    token: '',
    fetch: async (_url, init) => {
      const range = new Headers(init?.headers).get('range')!
      requests.push(range)
      expect(range).toBe('bytes=0-0')
      return new Response(bytes, {
        status: 206,
        headers: { 'content-range': 'bytes 0-0/1' },
      })
    },
  })
  const expected = { size, sha: await sha256(bytes) }
  expect(
    await fingerprintSource(http.openRange('/content?version_id=restored', expected))
  ).toMatchObject(expected)
  expect(requests).toEqual(size ? ['bytes=0-0'] : [])
})

it('retries only the current range and refuses an ignored range', async () => {
  const requests: string[] = []
  let failed = false
  const bytes = new Uint8Array(5).fill(2)
  const http = new Http({
    baseUrl: 'https://test',
    token: '',
    fetch: async (_url, init) => {
      const range = (init?.headers as Record<string, string>).range
      requests.push(range!)
      if (range === 'bytes=2-3' && !failed) {
        failed = true
        throw new Error('stall')
      }
      const [start, end] = range!.slice(6).split('-').map(Number) as [number, number]
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/5` },
      })
    },
  })
  const source = http.openRange('/content', { size: 5, sha: await sha256(bytes) })
  expect((await fingerprintSource(source, 2)).sha).toBe(await sha256(bytes))
  expect(requests).toEqual(['bytes=0-1', 'bytes=2-3', 'bytes=2-3', 'bytes=4-4'])
  const ignored = new Http({
    baseUrl: 'https://test',
    token: '',
    fetch: async () => new Response(bytes),
  })
  await expect(
    fingerprintSource(ignored.openRange('/content', { size: 5, sha: '' }))
  ).rejects.toThrow('range')
})

it.each([2, 4])('rejects a response of %i bytes for a three-byte range', async (length) => {
  const http = new Http({
    baseUrl: 'https://test',
    token: '',
    fetch: async () =>
      new Response(new Uint8Array(length), {
        status: 206,
        headers: { 'content-range': 'bytes 0-2/3' },
      }),
  })
  await expect(
    fingerprintSource(http.openRange('/content', { size: 3, sha: '' }))
  ).rejects.toThrow()
})

it('cancels a stalled range body and retries only that range', async () => {
  vi.useFakeTimers()
  let calls = 0
  let cancelled = false
  const controller = new AbortController()
  try {
    const http = new Http({
      baseUrl: 'https://test',
      token: '',
      transferStallMs: 10,
      fetch: async () => {
        calls++
        const body =
          calls === 1
            ? new ReadableStream({
                cancel() {
                  cancelled = true
                },
              })
            : new Uint8Array([1])
        return new Response(body, { status: 206, headers: { 'content-range': 'bytes 0-0/1' } })
      },
    })
    const pending = fingerprintSource(
      http.openRange('/content', { size: 1, sha: '' }, { signal: controller.signal })
    )
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(11)
    expect(settled).toBe(true)
    expect((await pending).size).toBe(1)
    expect(calls).toBe(2)
    expect(cancelled).toBe(true)
  } finally {
    controller.abort()
    vi.useRealTimers()
  }
})
