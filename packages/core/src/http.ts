import { AbeleError, ERROR_STATUS, ErrorCodeSchema, type ErrorCode } from '@abele/sync-protocol'
import { z } from 'zod'
import { EngineError } from './errors.js'

/**
 * The transport under the client (see `client.ts`): one request made, its token and its query
 * attached, and an answer read back as the protocol's own type or as the error it stands for.
 */

export interface ClientOptions {
  /** Where the server lives, scheme and all: `https://sync.example.com`. */
  baseUrl: string
  fetch: typeof fetch
  /** Only `subscribe` needs one. Hosts without a global `WebSocket` pass their own. */
  WebSocket?: typeof WebSocket
  /** An account token (`abst_…`) or a device token (`absd_…`), depending on what is being asked. */
  token: string
  userAgent?: string
  /** Above this, `putBlob` uploads in parts rather than in one request. */
  simpleUploadBytes?: number
}

/** What the server accepts in one `PUT`, and so where the resumable upload starts. */
export const DEFAULT_SIMPLE_UPLOAD_BYTES = 8 * 1024 * 1024

/** The error envelope, as this client reads it back off the wire. */
const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
})

/**
 * A schema as this client uses one: it takes whatever came off the wire and gives
 * back the protocol's own type. Naming the input `unknown` is what lets a schema
 * with defaults keep its parsed type rather than its looser input one.
 */
export type WireSchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>

/** A query string's values, as the caller has them: absent ones are simply not sent. */
type Query = Record<string, string | number | null | undefined>

/** What one request carries beyond its method and path. */
export interface SendInit {
  query?: Query
  headers?: Record<string, string>
  /** A JSON body, serialised here so the bytes and the content type always agree. */
  json?: unknown
  /** A body of bytes, sent as an octet stream. */
  bytes?: Uint8Array
}

/**
 * The one place a request is made: the url, the token, and the difference
 * between a server that answered badly and a server that never answered.
 */
export class Http {
  private readonly base: string

  constructor(private readonly opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
  }

  get baseUrl(): string {
    return this.base
  }
  get token(): string {
    return this.opts.token
  }

  get simpleUploadBytes(): number {
    return this.opts.simpleUploadBytes ?? DEFAULT_SIMPLE_UPLOAD_BYTES
  }

  /** The same path on the socket scheme the base url implies: `http` → `ws`, `https` → `wss`. */
  socketUrl(path: string): string {
    return `${this.base.replace(/^http/, 'ws')}${path}`
  }

  /** The host's `WebSocket`, or the one it was given. A host with neither cannot subscribe. */
  socketClass(): typeof WebSocket {
    const given = this.opts.WebSocket ?? globalThis.WebSocket
    if (given === undefined)
      throw new EngineError('io', 'this host has no WebSocket to subscribe with')
    return given
  }

  /**
   * One request. Anything but a 2xx throws — the server's own error when it sent
   * one, ours when it did not — unless the caller named the status it will handle
   * itself. A `fetch` that rejects never reached the server: that is `offline`.
   */
  async send(
    method: string,
    path: string,
    init: SendInit = {},
    tolerate: readonly number[] = []
  ): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers }
    if (this.opts.token !== '') headers['authorization'] = `Bearer ${this.opts.token}`
    if (this.opts.userAgent !== undefined) headers['user-agent'] = this.opts.userAgent

    let body: string | Uint8Array<ArrayBuffer> | undefined
    if (init.json !== undefined) {
      body = JSON.stringify(init.json)
      headers['content-type'] = 'application/json'
    } else if (init.bytes !== undefined) {
      // `fetch` wants a view onto an `ArrayBuffer`; every body we send is one, its
      // type just says `ArrayBufferLike`. Assert rather than copy the whole file.
      body = init.bytes as Uint8Array<ArrayBuffer>
      headers['content-type'] = 'application/octet-stream'
    }

    let response: Response
    try {
      response = await this.opts.fetch(`${this.base}${path}${queryString(init.query)}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      })
    } catch (cause) {
      throw new EngineError('offline', `${method} ${path} never reached the server`, cause)
    }

    if (!response.ok && !tolerate.includes(response.status))
      throw await failure(response, method, path)
    return response
  }

  /** A request whose answer must be the shape the protocol says it is. */
  async json<T>(
    schema: WireSchema<T>,
    method: string,
    path: string,
    init: SendInit = {}
  ): Promise<T> {
    return this.decode(schema, await this.send(method, path, init), method, path)
  }

  /** A request whose answer is bytes. */
  async bytes(method: string, path: string, init: SendInit = {}): Promise<Uint8Array> {
    const response = await this.send(method, path, init)
    try {
      return new Uint8Array(await response.arrayBuffer())
    } catch (cause) {
      // The headers arrived and the body did not: the connection went, not the protocol.
      throw new EngineError(
        'offline',
        `${method} ${path} was cut off before its body arrived`,
        cause
      )
    }
  }

  /** An answer already in hand, read as the schema says. A drift is the server's, not the caller's. */
  async decode<T>(
    schema: WireSchema<T>,
    response: Response,
    method: string,
    path: string
  ): Promise<T> {
    const raw = await textOf(response, method, path)
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch (cause) {
      throw new EngineError('protocol', `${method} ${path} answered a body that is not json`, cause)
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new EngineError(
        'protocol',
        `${method} ${path} answered something this client does not understand`,
        parsed.error
      )
    }
    return parsed.data
  }
}

/** The header a retryable write is filed under, when the caller named one. */
export const idempotency = (key: string | undefined): Pick<SendInit, 'headers'> =>
  key === undefined ? {} : { headers: { 'idempotency-key': key } }

/** The query a request carries; anything the caller left out is left off. */
function queryString(query: Query | undefined): string {
  if (query === undefined) return ''
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(name, String(value))
  }
  const rendered = params.toString()
  return rendered === '' ? '' : `?${rendered}`
}

/**
 * What a refused request means. The server's own envelope is thrown back as the
 * `AbeleError` it was sent as, so a caller switches on the code the protocol
 * defines.
 *
 * A refusal with no body at all is still the server's: a `HEAD` never carries
 * one, so its status is all there is to go on, and the status is what
 * `ERROR_STATUS` fixes each plain code to. Only a body that is there and is not
 * ours came from something else — a proxy, a captive portal, a front door that
 * turned the token away before the app ever saw it.
 */
async function failure(response: Response, method: string, path: string): Promise<Error> {
  const raw = await textOf(response, method, path)
  const envelope = envelopeOf(raw)
  if (envelope !== null) return new AbeleError(envelope.code, envelope.message, envelope.details)

  if (raw === '') {
    const code = BODILESS_CODES.get(response.status)
    if (code !== undefined) {
      return new AbeleError(code, `${method} ${path} was refused with ${response.status}`)
    }
  }
  if (response.status === 401) {
    return new EngineError('unauthorized', `${method} ${path} was refused: the token is no good`)
  }
  return new EngineError(
    'protocol',
    `${method} ${path} answered ${response.status} without an error envelope`
  )
}

/**
 * The codes a bare status is allowed to stand for: the plain ones, each the only
 * code the protocol gives its status. A status several codes share says nothing
 * about which of them it was, so nothing here guesses. `ERROR_STATUS` is what
 * pairs them, so this cannot drift from the protocol.
 */
const BODILESS_CODES = new Map<number, ErrorCode>(
  (['unauthorized', 'forbidden', 'not_found'] as const).map((code) => [ERROR_STATUS[code], code])
)

/** The body as text. A read that fails is a connection that failed, not an answer we dislike. */
export async function textOf(response: Response, method: string, path: string): Promise<string> {
  try {
    return await response.text()
  } catch (cause) {
    throw new EngineError('offline', `${method} ${path} was cut off before its body arrived`, cause)
  }
}

/** The error envelope in a body, if that is what the body was. */
export function envelopeOf(raw: string): ErrorEnvelope | null {
  if (raw === '') return null
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = ErrorEnvelopeSchema.safeParse(body)
  return parsed.success ? parsed.data.error : null
}

type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>['error']
