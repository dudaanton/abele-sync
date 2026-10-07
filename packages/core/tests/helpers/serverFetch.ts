import type { AddressInfo } from 'node:net'
import type { FastifyInstance, InjectOptions } from 'fastify'
import WebSocketImpl from 'ws'

/**
 * The server, reached the way production reaches it. `fetchFor` hands the client
 * a `fetch` that goes through `app.inject`, so a test exercises the client's own
 * url building, headers, status handling and body decoding — everything but the
 * socket. `wsFor` cannot fake a socket that way, so it starts the app on a free
 * port and binds a real `ws` client to it.
 */

/** Statuses the `Response` constructor refuses to carry a body for. */
const NO_BODY = new Set([101, 204, 205, 304])

/** The host part of a url is never used: every request is injected straight into the app. */
export function fetchFor(app: FastifyInstance): typeof fetch {
  const injected: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const { pathname, search } = new URL(href)

    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? {}).forEach((value, name) => {
      headers[name] = value
    })

    const method = (init?.method ?? 'GET').toUpperCase()
    const response = await app.inject({
      method: method as InjectOptions['method'],
      url: `${pathname}${search}`,
      headers,
      ...(init?.body === undefined || init?.body === null ? {} : { payload: payloadOf(init.body) }),
    })

    // `inject` hands back whatever the handler wrote, but a real connection never
    // carries a body on a HEAD — not even the error envelope a refused one wrote.
    // A client that saw one here would be tested against something it never meets.
    const bodiless = method === 'HEAD' || NO_BODY.has(response.statusCode)
    // `Response` wants a view onto an `ArrayBuffer`, which a `Buffer`'s type does not say it is.
    const body = response.rawPayload as Uint8Array<ArrayBuffer>
    return new Response(bodiless ? null : body, {
      status: response.statusCode,
      headers: headersOf(response.headers),
    })
  }
  return injected
}

/**
 * A `WebSocket` bound to the app's own port. The app starts listening on the
 * first call and stays up until the harness closes it; the constructor rewrites
 * whatever host the client derived from its base url to that port.
 */
export async function wsFor(app: FastifyInstance): Promise<typeof WebSocket> {
  if (app.server.address() === null) await app.listen({ port: 0 })
  const { port } = app.server.address() as AddressInfo

  class BoundSocket extends WebSocketImpl {
    constructor(url: string | URL, protocols?: string | string[]) {
      const bound = new URL(String(url))
      bound.host = `127.0.0.1:${port}`
      super(bound, protocols)
    }
  }

  // `ws` implements the browser interface the client codes against, not its types.
  return BoundSocket as unknown as typeof WebSocket
}

/** The client only ever sends text or bytes; anything else is a test that meant something else. */
function payloadOf(body: BodyInit): string | Buffer {
  if (typeof body === 'string') return body
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  throw new Error('the injected fetch carries text and bytes, nothing else')
}

/** Fastify's headers, as strings a `Headers` will take. */
function headersOf(raw: Record<string, number | string | string[] | undefined>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, String(one))
  }
  return headers
}
