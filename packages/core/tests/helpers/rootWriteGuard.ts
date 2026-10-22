import { AsyncLocalStorage } from 'node:async_hooks'
import type { StateStore } from '../../src/state.js'

interface Scope {
  root: object
  active: boolean
}
const callers = new AsyncLocalStorage<readonly Scope[]>()
const installed = new WeakSet<object>()
const violations: Error[] = []

function assertRoot(root: object, method: string): void {
  if (!callers.getStore()?.some((scope) => scope.root === root && scope.active)) return
  const error = new Error(`root state write ${method} inside transaction; use tx`)
  // Keep evidence even if a broad catch in an engine hook swallows the exception.
  violations.push(error)
  throw error
}

/** Node-only test instrumentation; never part of the browser SDK. Track the async
 * caller, not a global "transaction open" flag: unrelated tasks may write the root. */
export function guardRootWrites(prototype: object): void {
  if (installed.has(prototype)) return
  installed.add(prototype)
  const methods = prototype as Record<string, (...args: unknown[]) => unknown>
  for (const key of ['put', 'delete', 'setCursor', 'setJournal', 'setMeta']) {
    const original = methods[key]
    if (!original) continue
    methods[key] = function (...args) {
      assertRoot(this, key)
      return original.apply(this, args)
    }
  }
  const store = prototype as StateStore
  const transaction = store.transaction
  store.transaction = function <T>(
    this: StateStore,
    work: (tx: StateStore) => Promise<T>
  ): Promise<T> {
    assertRoot(this, 'transaction')
    if (!this.transactionScoped) return transaction.call(this, work) as Promise<T>
    return transaction.call(this, (tx) => {
      const scope: Scope = { root: this, active: true }
      return callers.run([...(callers.getStore() ?? []), scope], async () => {
        try {
          return await work(tx)
        } finally {
          scope.active = false
        }
      })
    }) as Promise<T>
  }
}

export function takeRootWriteViolations(): Error[] {
  return violations.splice(0)
}
