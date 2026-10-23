import type { StateStore } from './state.js'
import { transact } from './stateTransaction.js'
import { firstSettlementSequence } from './settlementIndex.js'

export interface AppliedFrontier {
  reached: number
  /** Includes captured but unapplied work. Explicit policy dispositions may
   * pass work only while retaining the legacy rediscovery obligation. */
  firstUnresolved: number | null
}

/** Publish unresolved-work changes and their applied frontier together. Callers
 * perform filesystem/network effects before entering this short transaction.
 * The frontier is sampled inside the transaction, after its work has been filed;
 * the returned cursor is usable only after durable publication succeeds. */
export async function commitAppliedSettlement(
  state: StateStore,
  frontier: () => AppliedFrontier | Promise<AppliedFrontier>,
  publish: (tx: StateStore) => Promise<void>
): Promise<number> {
  return transact(state, async (tx) => {
    await publish(tx)
    const { reached, firstUnresolved } = await frontier()
    const departure = await firstSettlementSequence(tx)
    const cursor = Math.min(reached, (firstUnresolved ?? Infinity) - 1, (departure ?? Infinity) - 1)
    await tx.setCursor(cursor)
    return cursor
  })
}
