import type { VaultClient } from './client.js'
import { EngineError } from './errors.js'
import type { FileSystem } from './fs.js'
import type { StateStore } from './state.js'

/**
 * The engine's hands, each checked against the host's `stillHeld` before it does anything that
 * leaves a mark: a commit, a write to the vault's disk, a write to the state. A host whose claim
 * on the vault lapsed mid-run (the daemon's lock) then has its run stop at
 * the next such step, with an `EngineError('lost')`, instead of running to the end beside
 * whoever holds the vault now. What was done before it stands, as after a crash: the journal
 * and the temp folder are the next holder's to settle.
 *
 * That includes the scope and aside marks, which file their meta through the same state
 *. Reads are never checked, and neither is anything the host does
 * outside the engine.
 */
export function guarded<T extends { client: VaultClient; fs: FileSystem; state: StateStore }>(
  opts: T,
  stillHeld: () => boolean
): T {
  const check = (what: string): void => {
    if (!stillHeld()) {
      throw new EngineError('lost', `the vault is no longer held here: nothing more to ${what}`)
    }
  }
  return {
    ...opts,
    client: checking(opts.client, check, {
      commitRaw: 'commit',
      commit: 'commit',
      putBlob: 'upload',
      restore: 'restore',
      restoreDeleted: 'restore',
      restoreDeletedMany: 'restore',
    }),
    fs: checking(opts.fs, check, { writeAtomic: 'write', move: 'write', remove: 'write' }),
    state: checking(opts.state, check, {
      put: 'record',
      delete: 'record',
      setCursor: 'record',
      setJournal: 'record',
      setMeta: 'record',
      transaction: 'record',
    }),
  }
}

/**
 * Stop waiting on a network request when a host stops the engine. A late response has no
 * continuation in the sync; the server may still finish a commit, which its journal replays
 * by key on the next run. A transport with AbortSignal support can additionally close its
 * socket, but correctness does not depend on that cancellation being honoured.
 */
export function stoppableClient(
  client: VaultClient,
  signalFor: () => AbortSignal,
  activeWrites: { count: number }
): VaultClient {
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        const signal = signalFor()
        if (signal.aborted) throw new EngineError('offline', 'sync stopped')
        const mutating = [
          'commitRaw',
          'commit',
          'putBlob',
          'restore',
          'restoreDeleted',
          'restoreDeletedMany',
          'updateSettings',
          'revokeVaultDevice',
        ].includes(String(key))
        if (mutating) activeWrites.count++
        let result: unknown
        try {
          result = (value as (...params: unknown[]) => unknown).apply(target, args)
        } catch (error) {
          if (mutating) activeWrites.count--
          throw error
        }
        if (!(result instanceof Promise)) {
          if (mutating) activeWrites.count--
          return result
        }
        if (mutating)
          return result.finally(() => {
            activeWrites.count--
          })
        return new Promise((resolve, reject) => {
          const abort = (): void => reject(new EngineError('offline', 'sync stopped'))
          signal.addEventListener('abort', abort, { once: true })
          result
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort))
            .catch(() => undefined)
          if (signal.aborted) abort()
        })
      }
    },
  })
}

/** Each proxy's own object, for what must know one store by its identity (`unguarded`). */
const targets = new WeakMap<object, object>()

/**
 * The object a guarded proxy stands for, or the object itself when it is not one. The marks
 * queue their work per store object, and a store seen through the guard is still that store.
 */
export function unguarded<T extends object>(value: T): T {
  return (targets.get(value) as T | undefined) ?? value
}

/**
 * The object itself, seen through a proxy that checks before the named methods. Every method
 * runs on the object, so a host's own fields and later reassignments of its methods (as tests
 * do) are what is called.
 */
function checking<T extends object>(
  target: T,
  check: (what: string) => void,
  methods: Partial<Record<keyof T & string, string>>
): T {
  const proxy = new Proxy(target, {
    get(obj, key) {
      const value: unknown = Reflect.get(obj, key)
      if (typeof value !== 'function') return value
      const what = typeof key === 'string' ? (methods as Record<string, string>)[key] : undefined
      if (what === undefined) return (value as (...args: unknown[]) => unknown).bind(obj)
      return (...args: unknown[]): unknown => {
        check(what)
        return (value as (...args: unknown[]) => unknown).apply(obj, args)
      }
    },
  })
  targets.set(proxy, target)
  return proxy
}
