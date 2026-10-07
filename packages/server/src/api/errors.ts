import { AbeleError, type ErrorBody } from '@abele/sync-protocol'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

/** What a client is told when the server broke: never the reason, never the stack. */
const INTERNAL_MESSAGE = 'internal error'

/**
 * Turn anything thrown into the one error envelope the protocol defines.
 * Everything the client could have done differently keeps its own code; anything
 * else is `internal`, and only the log learns what it was.
 */
export function toAbeleError(error: unknown): AbeleError {
  // An `internal` thrown from inside says what broke — a blob's name, an envelope
  // that would not open. The log gets that; the client gets the bare envelope.
  if (error instanceof AbeleError) {
    return error.code === 'internal' ? new AbeleError('internal', INTERNAL_MESSAGE) : error
  }
  if (error instanceof ZodError) {
    return new AbeleError('invalid_request', 'the request body is not valid', {
      issues: error.issues,
    })
  }

  const fastify = error as Partial<FastifyError> | null
  const code = fastify?.code
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE')
    return new AbeleError('too_large', 'the request body is too large')
  // A body Fastify could not parse at all: malformed JSON, a missing or unknown content type.
  if (typeof code === 'string' && code.startsWith('FST_ERR_CTP_')) {
    return new AbeleError('invalid_request', 'the request body could not be read')
  }
  // `@fastify/rate-limit` throws a plain error carrying only the status.
  if (fastify?.statusCode === 429)
    return new AbeleError('rate_limited', fastify.message ?? 'too many requests')

  return new AbeleError('internal', INTERNAL_MESSAGE)
}

/** The app's error handler: map, log what nobody may see, answer the envelope. */
export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const mapped = toAbeleError(error)
  if (mapped.code === 'internal') {
    console.error(`error handling ${request.method} ${request.url}:`, error)
  }
  send(reply, mapped)
}

/** No route matched: a plain `not_found`, in the same envelope as everything else. */
export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  send(reply, new AbeleError('not_found', `no route for ${request.method} ${request.url}`))
}

function send(reply: FastifyReply, error: AbeleError): void {
  const body: ErrorBody = error.toBody()
  void reply.code(error.status).send(body)
}
