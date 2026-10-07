import { AbeleError } from '@abele/sync-protocol'
import type { FastifyReply } from 'fastify'
import type { BlobStore } from '../blobs/store.js'

/**
 * Serving stored bytes. Two routes hand a blob back — the blob itself, and one
 * version of a file — and a client should not be able to tell them apart: the
 * same headers, the same ranges, the same refusals.
 */

/** A sha never names anything but one set of bytes, so a client may keep it for as long as it likes. */
export const CACHE_CONTROL = 'private, immutable, max-age=31536000'
export const OCTET_STREAM = 'application/octet-stream'

/**
 * Send a blob, whole or in the one range the request asked for: 200 for all of
 * it, 206 for a part, 416 for a range that is not inside it.
 */
export async function sendBlob(
  reply: FastifyReply,
  store: BlobStore,
  sha: string,
  rangeHeader: string | undefined
): Promise<FastifyReply> {
  const bytes = await store.get(sha)
  const range = typeof rangeHeader === 'string' ? parseRange(rangeHeader, bytes.length) : null

  if (range === 'unsatisfiable') {
    return reply
      .code(416)
      .header('content-range', `bytes */${bytes.length}`)
      .type('application/json')
      .send(new AbeleError('invalid_request', 'that range is not inside this blob').toBody())
  }

  const body = range === null ? bytes : bytes.subarray(range.start, range.end + 1)
  const reading = reply
    .type(OCTET_STREAM)
    .header('accept-ranges', 'bytes')
    .header('cache-control', CACHE_CONTROL)
    .header('content-length', String(body.length))
  if (range === null) return reading.code(200).send(body)
  return reading
    .code(206)
    .header('content-range', `bytes ${range.start}-${range.end}/${bytes.length}`)
    .send(body)
}

/** One byte range, or the two ways of having none: no range asked for, and one that cannot be served. */
type Range = { start: number; end: number } | 'unsatisfiable' | null

/**
 * Parse a `Range` header against a known total. Only single byte ranges are
 * served: a client asking for several gets a 416 rather than a body that
 * answers a different question than the one it asked. A header this server does
 * not understand at all is ignored, as HTTP asks, and the whole blob is sent.
 */
function parseRange(header: string, total: number): Range {
  const spec = header.trim()
  if (!spec.toLowerCase().startsWith('bytes=')) return null
  const value = spec.slice('bytes='.length).trim()
  if (value.includes(',')) return 'unsatisfiable'

  const parts = /^(\d*)-(\d*)$/.exec(value)
  if (!parts) return null
  const [, first = '', last = ''] = parts
  if (first === '' && last === '') return null
  if (total === 0) return 'unsatisfiable'

  if (first === '') {
    // `bytes=-n`: the last n bytes, or all of them when n is larger than the blob.
    const wanted = Number(last)
    if (wanted === 0) return 'unsatisfiable'
    return { start: Math.max(0, total - wanted), end: total - 1 }
  }

  const start = Number(first)
  const end = last === '' ? total - 1 : Math.min(Number(last), total - 1)
  if (start >= total || start > end) return 'unsatisfiable'
  return { start, end }
}
