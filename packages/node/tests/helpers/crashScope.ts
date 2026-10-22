import { AsyncLocalStorage } from 'node:async_hooks'

/** Awaited I/O can outlive Vitest's timeout. Its callbacks must retain their own
 * process model rather than mutating the injector used by the next test. */
export function crashScope<T extends object>(create: () => T) {
  const callers = new AsyncLocalStorage<T>()
  const idle = create()
  const state = new Proxy(idle, {
    get: (_target, key) => Reflect.get(callers.getStore() ?? idle, key),
    set: (_target, key, value) => Reflect.set(callers.getStore() ?? idle, key, value),
  })
  return { state, run: <R>(work: () => R): R => callers.run(create(), work) }
}
