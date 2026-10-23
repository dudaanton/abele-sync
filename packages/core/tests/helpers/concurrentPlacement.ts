import { expect } from 'vitest'
import {
  applyStaged,
  ExpectedWrites,
  MemoryFileSystem,
  sha256,
  type EngineClient,
  type StateStore,
} from '../../src/index.js'
import type { ChangeItem } from '@abele/sync-protocol'

/** Same ordered placement contract for native, legacy and host adapters. */
export async function concurrentPlacement(store: StateStore) {
  const fs = new MemoryFileSystem(),
    bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  const changes: ChangeItem[] = Array.from({ length: 6 }, (_, n) => ({
    seq: n + 1,
    file_id: `placement-${n}`,
    version_id: 'v1',
    path: `placed/${n}.bin`,
    prev_path: null,
    op: 'create',
    kind: 'attachment',
    sha,
    size: 1,
    mtime: 1,
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }))
  const applied: string[] = []
  const report = await applyStaged(
    { getBlob: async () => bytes } as unknown as EngineClient,
    fs,
    store,
    changes,
    {
      placementConcurrency: 3,
      expected: new ExpectedWrites(),
      dirty: new Set(),
      filter: { excluded: () => false },
      onApplied: (event) => {
        applied.push(event.path)
      },
    }
  )
  expect(report.applied).toBe(6)
  expect(applied).toEqual(changes.map((change) => change.path))
  for (const change of changes) {
    expect(await fs.read(change.path)).toEqual(bytes)
    expect(await store.byFileId(change.file_id)).toMatchObject({
      path: change.path,
      versionId: 'v1',
    })
    expect(await store.getMeta!(`pull-write:${change.file_id}`)).toBeNull()
  }
}

/** Plugin IndexedDB queues transactions internally and passes a distinct scoped
 * patch. Exercise that adapter shape without importing a host or opening its DB. */
export function queuedScopedState(state: StateStore): StateStore {
  let tail = Promise.resolve()
  return new Proxy(state, {
    get(target, key) {
      if (key === 'transaction')
        return <T>(work: (tx: StateStore) => Promise<T>) => {
          const result = tail.then(() => target.transaction(work))
          tail = result.then(
            () => {},
            () => {}
          )
          return result
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
