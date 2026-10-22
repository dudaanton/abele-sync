import type { EngineClient } from './engineClient.js'
import { EngineError } from './errors.js'
import type { FileSystem } from './fs.js'
import type { StateStore } from './state.js'
import type { ChunkSource } from './streaming.js'
import { checkCancellation } from './cancellation.js'

/** Inventory walks can be large, but have no file operation whose ledger must settle. */
export function stoppableListings(
  fs: FileSystem,
  signalFor: () => AbortSignal | undefined
): FileSystem {
  return new Proxy(fs, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'list' || key === 'listDirectories')
        return async function* (...args: unknown[]) {
          const signal = signalFor()
          checkCancellation(signal)
          const listed = (value as (...args: unknown[]) => AsyncIterable<unknown>).apply(
            target,
            args
          )
          for await (const item of listed) {
            checkCancellation(signal)
            yield item
          }
        }
      return (value as (...args: unknown[]) => unknown).bind(target)
    },
  })
}

function stopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new EngineError('offline', 'sync stopped'))
    signal.addEventListener('abort', abort, { once: true })
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined)
    if (signal.aborted) abort()
  })
}

function stoppedSource(source: ChunkSource, signal: AbortSignal, cleanup: () => void): ChunkSource {
  let closing: Promise<void> | undefined
  const close = () => {
    if (!closing) {
      signal.removeEventListener('abort', abort)
      cleanup()
      closing = Promise.resolve().then(() => source.close())
    }
    return closing
  }
  const abort = () => {
    void close().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return {
    size: source.size,
    signal,
    ...(source.stamp === undefined ? {} : { stamp: source.stamp }),
    read: (offset, length, cancellation) => {
      if (signal.aborted) return Promise.reject(new EngineError('offline', 'sync stopped'))
      return stopped(source.read(offset, length, cancellation), signal)
    },
    assertUnchanged: () => {
      if (signal.aborted) return Promise.reject(new EngineError('offline', 'sync stopped'))
      return stopped(source.assertUnchanged(), signal)
    },
    close,
  }
}

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
export function guarded<T extends { client: EngineClient; fs: FileSystem; state: StateStore }>(
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
      syncDirectories: 'commit',
      finishPull: 'write',
      retryRefusedDirectories: 'record',
      commit: 'commit',
      putBlob: 'upload',
      putBlobSource: 'upload',
      restore: 'restore',
      restoreDeleted: 'restore',
      restoreDeletedMany: 'restore',
    }),
    fs: checking(opts.fs, check, {
      beginAtomicWrite: 'write',
      reopenStage: 'write',
      discardStage: 'write',
      conditionalFile: 'write',
      recoverConditionalFiles: 'write',
      discardInstallation: 'write',
      writeAtomic: 'write',
      move: 'write',
      remove: 'write',
      mkdir: 'write',
      removeDirectory: 'write',
      moveDirectory: 'write',
    }),
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
  client: EngineClient,
  signalFor: () => AbortSignal,
  activeWrites: { count: number }
): EngineClient {
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'includes') return (value as (...args: unknown[]) => unknown).bind(target)
      return (...args: unknown[]): unknown => {
        const signal = signalFor()
        if (signal.aborted) {
          if (key === 'putBlobSource')
            return Promise.resolve((args[1] as ChunkSource).close()).then(() => {
              throw new EngineError('offline', 'sync stopped')
            })
          throw new EngineError('offline', 'sync stopped')
        }
        if (key === 'manifest' || key === 'changes') args[2] = signal
        if (key === 'getBlob') args[1] = signal
        if (key === 'versionBytes') args[2] = signal
        if (key === 'prepare') args[3] = signal
        if (key === 'putBlob') args[2] = signal
        let cleanup = () => {}
        if (key === 'openVersion' || key === 'putBlobSource') {
          const at = key === 'openVersion' ? 3 : 2
          const provided = args[at] as AbortSignal | undefined
          const controller = new AbortController()
          const abort = () => controller.abort(signal.aborted ? signal.reason : provided?.reason)
          signal.addEventListener('abort', abort, { once: true })
          provided?.addEventListener('abort', abort, { once: true })
          if (provided?.aborted) abort()
          args[at] = controller.signal
          cleanup = () => {
            signal.removeEventListener('abort', abort)
            provided?.removeEventListener('abort', abort)
          }
        }
        const mutating =
          (client.readEffects === true &&
            ['prepare', 'manifest', 'changes', 'scanLocal', 'rememberManifest'].includes(
              String(key)
            )) ||
          [
            'commitRaw',
            'syncDirectories',
            'finishPull',
            'retryRefusedDirectories',
            'commit',
            'putBlob',
            'putBlobSource',
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
          cleanup()
          if (mutating) activeWrites.count--
          throw error
        }
        if (!(result instanceof Promise)) {
          cleanup()
          if (mutating) activeWrites.count--
          return result
        }
        if (mutating)
          return result.finally(() => {
            cleanup()
            activeWrites.count--
          })
        if (key === 'openVersion') {
          const source = result.then(
            (value) => stoppedSource(value as ChunkSource, args[3] as AbortSignal, cleanup),
            (error) => {
              cleanup()
              throw error
            }
          )
          return stopped(source, signal)
        }
        cleanup()
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
        if (key === 'transaction') {
          const work = args[0] as (tx: StateStore) => Promise<unknown>
          args[0] = async (tx: StateStore | undefined) => {
            const result = await work(
              tx === undefined
                ? tx!
                : checking(tx, check, methods as Partial<Record<keyof StateStore & string, string>>)
            )
            check(what)
            return result
          }
        }
        const result = (value as (...args: unknown[]) => unknown).apply(obj, args)
        if (key === 'beginAtomicWrite' || key === 'reopenStage') {
          return Promise.resolve(result).then((stage) =>
            checking(stage as import('./streaming.js').AtomicStage, check, {
              append: 'write',
              seal: 'write',
              commit: 'write',
              discard: 'write',
            })
          )
        }
        return result
      }
    },
  })
  targets.set(proxy, target)
  return proxy
}
