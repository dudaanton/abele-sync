import type { StateStore } from './state.js'
import { transact } from './stateTransaction.js'

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
  frontier: () => AppliedFrontier,
  publish: (tx: StateStore) => Promise<void>
): Promise<number> {
  return transact(state, async (tx) => {
    await publish(tx)
    const { reached, firstUnresolved } = frontier()
    const cursor = Math.min(reached, firstUnresolved === null ? reached : firstUnresolved - 1)
    await tx.setCursor(cursor)
    return cursor
  })
}
