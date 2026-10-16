import { DELETE_SCOPE_REQUEST_HASH } from '../oplog/keyed.js'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'

/** Offline journals have no expiration. Only dead token principals can lose receipts. */
export async function sweepIdempotency(
  db: Kysely<Database>,
  olderThan: Date,
  liveActors?: readonly string[]
): Promise<number> {
  let query = db.deleteFrom('idempotency').where('created_at', '<', olderThan.toISOString())
  if (liveActors === undefined)
    query = query.where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('access_tokens')
            .select('id')
            .whereRef('access_tokens.id', '=', 'idempotency.actor_id')
            .where('revoked_at', 'is', null)
        )
      )
    )
  else if (liveActors.length) query = query.where('actor_id', 'not in', [...liveActors])
  // Self-deletion receipts remain replayable by their revoked secret until metadata purge.
  if (liveActors === undefined)
    query = query.where((eb) =>
      eb.or([
        eb('request_hash', '!=', DELETE_SCOPE_REQUEST_HASH),
        eb.not(
          eb.exists(
            eb
              .selectFrom('access_tokens')
              .select('id')
              .whereRef('access_tokens.id', '=', 'idempotency.actor_id')
          )
        ),
      ])
    )
  return Number((await query.executeTakeFirst()).numDeletedRows ?? 0n)
}
