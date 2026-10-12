import { describe, expect, it } from 'vitest'
import { AbeleError } from '@abele/sync-protocol'
import { EngineError, type EngineErrorCode } from '../../src/errors.js'
import { classifyFailure } from '../../src/engineTypes.js'
import { ExternalStateError } from '../../src/external/state.js'
import { Http } from '../../src/http.js'

const path = '/v1/external-files/capabilities'
function rejectingHttp(error: unknown) {
  return new Http({
    baseUrl: 'https://issuer.example.test',
    token: 'device',
    fetch: async () => {
      throw error
    },
  })
}

describe('transport rejections', () => {
  const codes: EngineErrorCode[] = ['offline', 'unauthorized', 'protocol', 'conflict', 'io', 'lost']
  it.each(codes)('preserves a transport EngineError with code %s as-is', async (code) => {
    const cause = new Error('native transport failure')
    const error = new EngineError(code, 'precise transport diagnosis', cause)
    await expect(rejectingHttp(error).send('GET', path)).rejects.toBe(error)
    expect(classifyFailure(error)).toBe(
      code === 'offline' ? 'offline' : code === 'unauthorized' ? 'unauthorized' : 'other'
    )
  })

  it('keeps an unclassified network failure offline and retryable with its cause', async () => {
    const cause = new TypeError('fetch failed')
    const error = await rejectingHttp(cause)
      .send('GET', path)
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(EngineError)
    expect(error).toMatchObject({
      code: 'offline',
      message: `GET ${path} never reached the server`,
      cause,
    })
    expect((error as EngineError).cause).toBe(cause)
    expect(classifyFailure(error)).toBe('offline')
  })

  it('preserves an external state fence refusal', async () => {
    const error = new ExternalStateError('recovery-required')
    await expect(rejectingHttp(error).send('GET', path)).rejects.toBe(error)
  })
})

function http(status: number, body: string) {
  return new Http({
    baseUrl: 'https://issuer.example.test',
    token: 'device',
    fetch: async () => new Response(body, { status }),
  })
}
describe('HTTP refusal status survives error parsing', () => {
  for (const status of [401, 403, 404, 500])
    it(`BUG: retains HTTP ${status} for a non-envelope proxy page without exposing the body`, async () => {
      const error = await http(status, '<html>Private proxy response</html>')
        .send('GET', path)
        .catch((error: unknown) => error)
      expect(error).toBeInstanceOf(EngineError)
      expect(error).toMatchObject({ code: status === 401 ? 'unauthorized' : 'protocol', status })
      expect((error as Error).message).not.toContain('Private proxy response')
    })
  it('keeps an authorized server error envelope and its specific access-refusal code unchanged', async () => {
    const error = await http(
      403,
      JSON.stringify({
        error: {
          code: 'account_password_required',
          message: 'Password required',
          details: { scope: 'request' },
        },
      })
    )
      .send('GET', path)
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AbeleError)
    expect(error).toMatchObject({
      code: 'account_password_required',
      status: 403,
      details: { scope: 'request' },
    })
  })
})
