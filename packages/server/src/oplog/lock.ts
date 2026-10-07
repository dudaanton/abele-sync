import { Mutex } from 'async-mutex'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Dialect } from '../db/connect.js'
import type { Database } from '../db/schema.js'

/**
 * One in-process mutex per vault, made on first use and dropped once nobody
 * waits on it. SQLite has no row lock a second process could take, so two
 * commits to one vault in this process queue here. Commits to different vaults
 * do not wait on each other *here* — but on SQLite they wait on each other
 * anyway: Kysely's SQLite dialect has one connection, and a transaction holds
 * it until it ends, so every vault's commits are serialised through that one
 * connection's mutex. The map below only decides what a second commit to the
 * same vault waits on; it does not make vaults independent.
 */
const mutexes = new Map<string, Mutex>()

/**
 * Run `fn` inside one transaction that owns the vault. On Postgres the vault's
 * advisory lock is taken first and released with the transaction; on SQLite the
 * per-vault mutex is held around the whole transaction as well. Either way, two
 * commits to one vault never interleave, so `head_seq` moves without gaps.
 */
export async function withVaultLock<T>(
  db: Kysely<Database>,
  dialect: Dialect,
  vaultId: string,
  fn: (trx: Transaction<Database>) => Promise<T>,
  beforeVault?: (trx: Transaction<Database>) => Promise<void>
): Promise<T> {
  const run = (): Promise<T> =>
    db.transaction().execute(async (trx) => {
      await beforeVault?.(trx)
      if (dialect === 'pg') {
        await sql`select pg_advisory_xact_lock(hashtext(${vaultId}))`.execute(trx)
      }
      return fn(trx)
    })

  if (dialect !== 'sqlite') return run()

  let mutex = mutexes.get(vaultId)
  if (mutex === undefined) {
    mutex = new Mutex()
    mutexes.set(vaultId, mutex)
  }
  try {
    return await mutex.runExclusive(run)
  } finally {
    if (!mutex.isLocked()) mutexes.delete(vaultId)
  }
}
