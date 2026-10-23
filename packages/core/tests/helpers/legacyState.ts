import type { StateStore } from '../../src/state.js'

/** Old hosts reserve root access and expose their active transaction through it. */
export function legacyState(state: StateStore, rootHandle = false): StateStore {
  let active = state
  const root = new Proxy(state, {
    get(_target, key) {
      if (key === 'transactionScoped') return false
      if (key === 'transaction')
        return async <T>(work: (tx?: StateStore) => Promise<T>) =>
          state.transaction(async (tx) => {
            active = tx
            try {
              return await work(rootHandle ? root : undefined)
            } finally {
              active = state
            }
          })
      const value = Reflect.get(active, key, active)
      return typeof value === 'function' ? value.bind(active) : value
    },
  })
  return root
}
