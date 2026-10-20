import { AbeleError, ERROR_STATUS, ErrorCodeSchema, type ErrorCode } from '@abele/sync-protocol'
import {
  RESTORE_GENERATION_HEADER,
  V2_CAPABILITIES_HEADER,
  V2_READ_ONLY_CAPABILITY,
} from '@abele/sync-protocol'
import { z } from 'zod'
import { EngineError, HttpError } from './errors.js'
import { ExternalStateError } from './external/state.js'
import { MAX_CHUNK_BYTES, type ChunkSource, type ContentIdentity } from './streaming.js'

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
  /** The bearer key of this token connection. The transport never infers access from it. */
  token: string
  item?: string
  userAgent?: string
  /** Above this, `putBlob` uploads in parts rather than in one request. */
  simpleUploadBytes?: number
  /** Inactivity ceiling for strict ranges; progress resets it (default 30 seconds). */
  transferStallMs?: number
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
  signal?: AbortSignal
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
  /** Pinned by the sync handshake. Absent on old servers. */
  generation: string | undefined
  observedGeneration: string | undefined

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

  private stallWatch(parent: AbortSignal) {
    const controller = new AbortController()
    const abort = () => controller.abort(parent.reason)
    parent.addEventListener('abort', abort, { once: true })
    if (parent.aborted) abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    const progress = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(
        () => controller.abort(new EngineError('offline', 'chunk transfer stalled')),
        this.opts.transferStallMs ?? 30_000
      )
    }
    progress()
    return {
      signal: controller.signal,
      progress,
      close: () => {
        if (timer !== undefined) clearTimeout(timer)
        parent.removeEventListener('abort', abort)
      },
    }
  }

  /** Each bounded upload part has its own deadline; a large file has no total deadline. */
  async sendChunk(
    method: string,
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<Response> {
    const watch = this.stallWatch(signal ?? new AbortController().signal)
    try {
      return await this.send(method, path, { bytes, signal: watch.signal })
    } catch (error) {
      signal?.throwIfAborted()
      if (watch.signal.aborted) throw watch.signal.reason
      throw error
    } finally {
      watch.close()
    }
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
   * itself. Preserve a host transport's classified error; an unclassified
   * `fetch` rejection is treated as `offline`.
   */
  async send(
    method: string,
    path: string,
    init: SendInit = {},
    tolerate: readonly number[] = []
  ): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers }
    if (this.opts.item !== undefined) headers['abele-scope-item'] = this.opts.item
    headers[V2_CAPABILITIES_HEADER] = V2_READ_ONLY_CAPABILITY
    if (this.generation !== undefined) headers[RESTORE_GENERATION_HEADER] = this.generation
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
        ...(init.signal === undefined ? {} : { signal: init.signal }),
        ...(body === undefined ? {} : { body }),
      })
    } catch (cause) {
      init.signal?.throwIfAborted()
      // Keep the host's transport diagnosis and effect fence refusals intact.
      if (cause instanceof ExternalStateError || cause instanceof EngineError) throw cause
      throw new EngineError('offline', `${method} ${path} never reached the server`, cause)
    }

    this.observedGeneration = response.headers.get(RESTORE_GENERATION_HEADER) ?? undefined
    if (
      this.generation !== undefined &&
      this.observedGeneration !== undefined &&
      this.generation !== this.observedGeneration
    )
      throw new EngineError(
        'conflict',
        'server generation changed; local files are preserved; retry to reconcile'
      )
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

  /** Immutable content, one strict range at a time; ownership belongs to the caller. */
  openRange(path: string, expected: ContentIdentity, init: SendInit = {}): ChunkSource {
    const controller = new AbortController()
    const abort = () => controller.abort(init.signal?.reason)
    init.signal?.addEventListener('abort', abort, { once: true })
    if (init.signal?.aborted) abort()
    return {
      size: expected.size,
      signal: controller.signal,
      read: async (offset, length, signal) => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > MAX_CHUNK_BYTES ||
          offset + length > expected.size
        )
          throw new EngineError('protocol', 'invalid range length')
        const cancel = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
        try {
          for (let attempt = 0; ; attempt++) {
            controller.signal.throwIfAborted()
            const watch = this.stallWatch(controller.signal)
            try {
              const end = offset + length - 1
              const response = await this.send('GET', path, {
                ...init,
                signal: watch.signal,
                headers: { ...init.headers, range: `bytes=${offset}-${end}` },
              })
              watch.progress()
              if (
                response.status !== 206 ||
                response.headers.get('content-range') !== `bytes ${offset}-${end}/${expected.size}`
              ) {
                await response.body?.cancel()
                throw new EngineError('protocol', 'server did not honor the exact range')
              }
              const declared = response.headers.get('content-length')
              if (declared !== null && Number(declared) !== length) {
                await response.body?.cancel()
                throw new EngineError('protocol', 'invalid range body length')
              }
              if (!response.body)
                throw new EngineError('protocol', 'range response has no streaming body')
              const reader = response.body.getReader()
              const bytes = new Uint8Array(length)
              let filled = 0
              const cancelRead = () => {
                void reader.cancel().catch(() => {})
              }
              watch.signal.addEventListener('abort', cancelRead, { once: true })
              try {
                for (;;) {
                  watch.signal.throwIfAborted()
                  const result = await reader.read()
                  watch.signal.throwIfAborted()
                  if (result.done) break
                  if (result.value.length > length - filled)
                    throw new EngineError('protocol', 'oversized range body')
                  bytes.set(result.value, filled)
                  filled += result.value.length
                  if (result.value.length > 0) watch.progress()
                }
                if (filled !== length) throw new EngineError('offline', 'truncated range body')
                return bytes
              } finally {
                watch.signal.removeEventListener('abort', cancelRead)
                await reader.cancel().catch(() => {})
                reader.releaseLock()
              }
            } catch (error) {
              controller.signal.throwIfAborted()
              if (!(error instanceof EngineError && error.code === 'offline') || attempt >= 2)
                throw error
            } finally {
              watch.close()
            }
          }
        } finally {
          signal?.removeEventListener('abort', cancel)
        }
      },
      async assertUnchanged() {
        controller.signal.throwIfAborted()
      },
      async close() {
        init.signal?.removeEventListener('abort', abort)
        controller.abort()
      },
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
    return new HttpError(
      response.status,
      'unauthorized',
      `${method} ${path} was refused: the token is no good`
    )
  }
  return new HttpError(
    response.status,
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
