import { createHash } from 'node:crypto'
import { AbeleError } from '@abele/sync-protocol'
import type {
  FastifyReply,
  FastifyRequest,
  onSendHookHandler,
  preHandlerHookHandler,
} from 'fastify'
import type { Kysely } from 'kysely'
import type { CommitResponse } from '@abele/sync-protocol'
import { deviceOf } from '../auth/hooks.js'
import type { Config } from '../config.js'
import type { Database } from '../db/schema.js'
import { type KeyedRun, type Replay } from '../oplog/keyed.js'

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set on the routes a client may retry with an `Idempotency-Key`. */
    idempotent?: boolean
  }
  interface FastifyRequest {
    /** The JSON body exactly as it arrived, kept by the app's parser so it can be hashed. */
    rawBody: string | null
    /** What the answer to this request will be filed under, or null when nothing is to be filed. */
    idempotency: PendingKey | null
  }
}

/** A key the handler is about to run under; the `onSend` hook files the answer against it. */
export interface PendingKey {
  actorId: string
  key: string
  hash: string
  /** The commit this key guarded, once the route hands the key on to it (`keyedFor`). */
  run?: KeyedRun
}

/** What the idempotency store needs: the table, the ttl, and the clock. */
export interface IdempotencyDeps {
  db: Kysely<Database>
  config: Config
  now?: () => Date
}

const HEADER = 'idempotency-key'

/** The header telling the response what it is. Stored answers are all JSON. */
const JSON_TYPE = 'application/json; charset=utf-8'

/** What a replayed answer carries, so a client can tell it from a fresh one. */
const REPLAYED = 'Idempotent-Replayed'

/**
 * The retry side of a commit. A client that never heard the answer sends the
 * request again under the same key: the first answer is handed back rather than
 * the batch applied twice, and a key reused for a different request is refused
 * instead of quietly answering about something else.
 *
 * Only routes carrying `config: { idempotent: true }` take part, and only
 * requests that name a key; everything else runs as though none of this existed.
 */
export function idempotency(deps: IdempotencyDeps): preHandlerHookHandler {
  return async (request, reply) => {
    if (request.routeOptions.config?.idempotent !== true) return
    const key = keyOf(request)
    if (key === null) return

    // Every idempotent route is a device's, and a key is that device's own.
    const actorId = deviceOf(request).deviceId
    const hash = hashOf(request)
    const stored = await deps.db
      .selectFrom('idempotency')
      .select(['request_hash', 'status', 'response', 'created_at'])
      .where('actor_id', '=', actorId)
      .where('key', '=', key)
      .executeTakeFirst()

    // Journals have no expiry. A live device's receipt must outlive any retry.
    if (stored !== undefined) {
      if (stored.request_hash !== hash) {
        throw new AbeleError(
          'idempotency_mismatch',
          'that idempotency key was used for a different request'
        )
      }
      // The stored answer is sent as it was serialized; the handler never runs,
      // so no vault is locked and nothing is written a second time.
      return reply
        .code(stored.status)
        .header(REPLAYED, 'true')
        .header('content-type', JSON_TYPE)
        .send(stored.response)
    }

    request.idempotency = { actorId, key, hash }
  }
}

/**
 * The key a request came under, handed to the commit it guards so the answer is looked up and
 * filed inside that commit's transaction (`oplog/keyed.ts`). `answer` makes the route's reply
 * from the commit's response, and is what is filed. Undefined for a request with no key.
 */
export function keyedFor(
  request: FastifyRequest,
  deps: IdempotencyDeps,
  answer: (response: CommitResponse) => unknown
): KeyedRun | undefined {
  const pending = request.idempotency
  if (pending === null) return undefined
  const { actorId, key, hash } = pending
  const run: KeyedRun = {
    actorId,
    key,
    hash,
    ttlMs: deps.config.idempotencyTtlMs,
    answer,
    filed: false,
  }
  pending.run = run
  return run
}

/** Send what a request was answered with before, as it was serialized then. */
export function sendReplay(reply: FastifyReply, replay: Replay): FastifyReply {
  return reply
    .code(replay.status)
    .header(REPLAYED, 'true')
    .header('content-type', JSON_TYPE)
    .send(replay.response)
}

/**
 * File the answer as it goes out. Only a handler that really ran under a key
 * files anything, and only a success: the server breaking is not an answer a
 * retry should be held to, and neither is a refusal — a client that fixes what
 * was wrong and asks again under the same key is owed a fresh run, not the
 * refusal read back to it.
 */
export function recordIdempotent(deps: IdempotencyDeps): onSendHookHandler {
  return async (request, reply, payload) => {
    const pending = request.idempotency
    if (pending === null) return payload
    // Whatever happens next, this answer is filed at most once.
    request.idempotency = null
    // Filed already, with the commit it answers; or replayed, which files nothing.
    if (pending.run !== undefined) return payload
    if (reply.statusCode >= 300) return payload
    // Anything not already a string is a stream or bytes, which no route here sends.
    if (typeof payload !== 'string') return payload

    try {
      const created_at = (deps.now?.() ?? new Date()).toISOString()
      await deps.db
        .insertInto('idempotency')
        .values({
          actor_id: pending.actorId,
          key: pending.key,
          request_hash: pending.hash,
          status: reply.statusCode,
          response: payload,
          created_at,
        })
        .onConflict((oc) =>
          oc.columns(['actor_id', 'key']).doUpdateSet({
            request_hash: pending.hash,
            status: reply.statusCode,
            response: payload,
            created_at,
          })
        )
        .execute()
    } catch (error) {
      // The work is done and the answer is on its way; only the retry loses out.
      console.error(`the answer to ${request.method} ${request.url} was not filed:`, error)
    }
    return payload
  }
}

/**
 * Only revoked or deleted devices can no longer retry. Keep receipts for live
 * devices indefinitely: the client journal has no bounded offline lifetime.
 */
export async function sweepIdempotency(db: Kysely<Database>, olderThan: Date): Promise<number> {
  const swept = await db
    .deleteFrom('idempotency')
    .where('created_at', '<', olderThan.toISOString())
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('devices')
            .select('id')
            .whereRef('devices.id', '=', 'idempotency.actor_id')
            .where('revoked_at', 'is', null)
        )
      )
    )
    .executeTakeFirst()
  return Number(swept.numDeletedRows ?? 0n)
}

/** The key this request names, or null for a request that names none. */
function keyOf(request: FastifyRequest): string | null {
  const header = request.headers[HEADER]
  const raw = Array.isArray(header) ? header[0] : header
  const key = raw?.trim() ?? ''
  return key === '' ? null : key
}

/**
 * What the request is, in one line: what it does, what it does it to, and the
 * body exactly as it arrived. The body alone would not do — two restores of
 * different files carry no body at all, and under one key the second would be
 * answered with the first one's work.
 */
function hashOf(request: FastifyRequest): string {
  return createHash('sha256')
    .update(`${request.method}\n${request.url}\n${request.rawBody ?? ''}`, 'utf8')
    .digest('hex')
}
