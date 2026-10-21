import type { FileSystem } from './fs.js'
import { checkCancellation } from './cancellation.js'

/** One read phase shares an inventory; callers invalidate it after disk effects. */
export function scanSnapshot(fs: FileSystem, signal: () => AbortSignal | undefined) {
  const snapshots = new Map<PropertyKey, Promise<unknown[]>>()
  const proxy = new Proxy(fs, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'list' || key === 'listDirectories')
        return async function* () {
          let snapshot = snapshots.get(key)
          if (!snapshot) {
            snapshot = (async () => {
              const items: unknown[] = []
              for await (const item of (value as () => AsyncIterable<unknown>).call(target)) {
                checkCancellation(signal())
                items.push(item)
              }
              return items
            })()
            snapshots.set(key, snapshot)
          }
          yield* await snapshot
        }
      return (value as (...args: unknown[]) => unknown).bind(target)
    },
  })
  return { fs: proxy, invalidate: () => snapshots.clear() }
}
