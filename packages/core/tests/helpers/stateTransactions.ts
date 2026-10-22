import type { StateStore } from '../../src/state.js'

/** Test instrumentation follows the capability: root methods no longer see private writes. */
export function decorateStateTransactions(
  state: StateStore,
  decorate: (tx: StateStore) => void
): void {
  const transaction = state.transaction.bind(state)
  state.transaction = (work) =>
    transaction(async (tx) => {
      decorateStateTransactions(tx, decorate)
      return work(tx)
    })
  decorate(state)
}
