import { AbeleError, type CommitResponse } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'

/**
 * An idempotency key carried into the commit it guards (`api/idempotency.ts`). The key is looked
 * up again and the answer filed inside the commit's own transaction, under the vault's lock:
 *
 * - the answer and the batch land together or not at all, so no crash can leave a batch
 *   committed with nothing for its retry to read back;
 * - a second request under the same key — a retry sent while the first was still running —
 *   waits on the same lock (a key is one device's, and a device has one vault), then finds the
 *   first one's answer and replays it instead of running the batch again.
 */
export interface KeyedRun {
  actorId: string
  key: string
  /** What the request was; the same key for a different request is refused. */
  hash: string
  /** How long a filed answer is worth replaying. */
  ttlMs: number
  /** What the route answers with, made from the commit's response. */
  answer: (response: CommitResponse) => unknown
  /** Set once the answer is filed with the commit; nothing is filed for it again on the way out. */
  filed: boolean
}

/** A request already answered under its key: the route sends this instead of running. */
export class Replay extends Error {
  constructor(
    readonly status: number,
    readonly response: string
  ) {
    super('answered before under this idempotency key')
    this.name = 'Replay'
  }
}

/**
 * Throw `Replay` for an existing receipt regardless of age, or mismatch for a
 * different request. Offline journals are unbounded, so live receipts never expire.
 */
export async function replayIfAnswered(
  trx: Transaction<Database>,
  keyed: KeyedRun,
  _at: Date
): Promise<void> {
  const stored = await trx
    .selectFrom('idempotency')
    .select(['request_hash', 'status', 'response', 'created_at'])
    .where('actor_id', '=', keyed.actorId)
    .where('key', '=', keyed.key)
    .executeTakeFirst()
  if (stored === undefined) return
  if (stored.request_hash !== keyed.hash) {
    throw new AbeleError(
      'idempotency_mismatch',
      'that idempotency key was used for a different request'
    )
  }
  throw new Replay(stored.status, stored.response)
}

/** File the answer in the commit's transaction. */
export async function fileAnswer(
  trx: Transaction<Database>,
  keyed: KeyedRun,
  response: CommitResponse,
  at: Date
): Promise<void> {
  const created_at = at.toISOString()
  const body = JSON.stringify(keyed.answer(response))
  await trx
    .insertInto('idempotency')
    .values({
      actor_id: keyed.actorId,
      key: keyed.key,
      request_hash: keyed.hash,
      status: 200,
      response: body,
      created_at,
    })
    .onConflict((oc) =>
      oc.columns(['actor_id', 'key']).doUpdateSet({
        request_hash: keyed.hash,
        status: 200,
        response: body,
        created_at,
      })
    )
    .execute()
}

/** Whether a stored answer is still within the ttl. A timestamp nobody can read is not. */
export function isFresh(createdAt: string, ttlMs: number, at: Date): boolean {
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return false
  return at.getTime() - created < ttlMs
}
