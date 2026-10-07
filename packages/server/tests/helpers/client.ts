import type { FastifyInstance, InjectOptions } from 'fastify'

/** One response, with the body already decoded when the server said it was JSON. */
export interface Res {
  status: number
  /** Parsed JSON when the response was JSON, otherwise the raw text. */
  body: any
  headers: Record<string, string | string[] | undefined>
  raw: string
  /** The bytes exactly as they arrived, for a body that is not text. */
  buffer: Buffer
}

export interface RawRequest {
  method: string
  url: string
  payload?: Buffer | string
  headers?: Record<string, string>
}

/**
 * A tiny HTTP client over `app.inject`, so a test talks to the server the way a
 * client does: a bearer token, a JSON body, and whatever the route answers.
 */
export function api(app: FastifyInstance, token?: string) {
  const send = async (options: InjectOptions): Promise<Res> => {
    const headers: Record<string, string> = {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...((options.headers ?? {}) as Record<string, string>),
    }
    const response = await app.inject({ ...options, headers })
    const raw = response.body
    const contentType = response.headers['content-type']
    const isJson = typeof contentType === 'string' && contentType.includes('json')
    return {
      status: response.statusCode,
      body: isJson && raw !== '' ? JSON.parse(raw) : raw,
      headers: response.headers as Record<string, string | string[] | undefined>,
      raw,
      buffer: response.rawPayload,
    }
  }

  const withBody =
    (method: 'POST' | 'PUT' | 'PATCH') =>
    (url: string, body?: unknown, headers?: Record<string, string>): Promise<Res> =>
      send({
        method,
        url,
        headers,
        // A test may send anything at all, including what a route will refuse.
        ...(body === undefined ? {} : { payload: body as InjectOptions['payload'] }),
      })

  return {
    get: (url: string, headers?: Record<string, string>): Promise<Res> =>
      send({ method: 'GET', url, headers }),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    del: (url: string, headers?: Record<string, string>): Promise<Res> =>
      send({ method: 'DELETE', url, headers }),
    raw: (options: RawRequest): Promise<Res> =>
      send({
        method: options.method as InjectOptions['method'],
        url: options.url,
        headers: options.headers,
        ...(options.payload === undefined ? {} : { payload: options.payload }),
      }),
  }
}
