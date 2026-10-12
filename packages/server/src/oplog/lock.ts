import { Mutex } from 'async-mutex'
import { setTimeout as delay } from 'node:timers/promises'
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
    return await mutex.runExclusive(async () => {
      const started = performance.now()
      for (let attempt = 0; ; attempt++) {
        try {
          return await run()
        } catch (error) {
          const code = (error as { code?: string } | null)?.code
          const remaining = 5000 - (performance.now() - started)
          if (
            attempt >= 7 ||
            remaining <= 0 ||
            !code ||
            !(code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'))
          )
            throw error
          // A snapshot cannot be upgraded by retrying a statement. Rollback already
          // happened; replay authorization, proof, dedup, rows and receipt as one unit.
          // Read-to-write upgrades can return BUSY immediately, bypassing busy_timeout.
          // Give an independent writer time to finish its async work: up to 4.5s
          // of backoff, within the connection's 5s contention budget, not just 310ms.
          await delay(Math.min(100 * 2 ** attempt, 1000, remaining))
        }
      }
    })
  } finally {
    if (!mutex.isLocked()) mutexes.delete(vaultId)
  }
}
