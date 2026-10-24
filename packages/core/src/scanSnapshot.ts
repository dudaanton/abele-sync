import type { FileSystem } from './fs.js'
import { checkCancellation } from './cancellation.js'
import { ScanWork, type ScanScheduling } from './scanWork.js'

/** One read phase shares an inventory; callers invalidate it after disk effects. */
export function scanSnapshot(
  fs: FileSystem,
  signal: () => AbortSignal | undefined,
  opts: ScanScheduling = {}
) {
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
              const work = new ScanWork({ ...opts, signal: signal() })
              for await (const item of (value as () => AsyncIterable<unknown>).call(target)) {
                checkCancellation(signal())
                await work.step()
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
