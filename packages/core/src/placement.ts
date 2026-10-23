import { caseKey, type ChangeItem } from '@abele/sync-protocol'
import { checkCancellation } from './cancellation.js'
import type { StateStore } from './state.js'

export function placementLimit(value = 1): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32)
    throw new RangeError('placementConcurrency must be a safe integer from 1 to 32')
  return value
}

/** Root writes must not invalidate another participant's open transaction.
 * Transaction callbacks receive the real isolated capability, never this queue. */
export function placementState(state: StateStore): StateStore {
  let tail = Promise.resolve()
  const writes = new Set(['transaction', 'put', 'delete', 'setMeta', 'setCursor', 'setJournal'])
  return new Proxy(state, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (!writes.has(String(key))) return value.bind(target)
      return (...args: unknown[]) => {
        const result = tail.then(() => Reflect.apply(value, target, args))
        tail = result.then(
          () => {},
          () => {}
        )
        return result
      }
    },
  })
}

/** Moves/deletes may discover additional names while resolving the ledger. Keep
 * them alone; ordinary destination aliases and ancestor paths conflict too. */
export interface PlacementFootprint {
  paths: string[]
  identities: string[]
  exclusive: boolean
}
export function* placementWaves(
  changes: ChangeItem[],
  limit: number,
  footprints: Map<ChangeItem, PlacementFootprint>
): Generator<ChangeItem[]> {
  let wave: ChangeItem[] = []
  const exclusive = (c: ChangeItem) => footprints.get(c)!.exclusive
  const conflicts = (a: ChangeItem, b: ChangeItem) => {
    const left = footprints.get(a)!,
      right = footprints.get(b)!
    return (
      a.file_id === b.file_id ||
      left.identities.some((id) => right.identities.includes(id)) ||
      left.paths.some((x) =>
        right.paths.some((y) => x === y || x.startsWith(y + '/') || y.startsWith(x + '/'))
      )
    )
  }
  for (const change of changes) {
    if (
      wave.length &&
      (wave.length === limit ||
        exclusive(change) ||
        wave.some((c) => exclusive(c) || conflicts(c, change)))
    ) {
      yield wave
      wave = []
    }
    wave.push(change)
  }
  if (wave.length) yield wave
}

export async function placementFootprints(
  changes: ChangeItem[],
  state: StateStore,
  fs: import('./fs.js').FileSystem,
  signal?: AbortSignal
): Promise<Map<ChangeItem, PlacementFootprint>> {
  const result = new Map<ChangeItem, PlacementFootprint>()
  for (const c of changes) {
    checkCancellation(signal)
    const entry = await state.byFileId(c.file_id)
    const paths = [
      ...new Set(
        [c.path, c.prev_path, entry?.path, entry?.wirePath].filter((p): p is string => !!p)
      ),
    ]
    const identities: string[] = []
    if (fs.fileIdentity)
      for (const path of paths) {
        const id = await fs.fileIdentity(path)
        if (id !== null && id !== undefined) identities.push(id)
      }
    result.set(c, {
      paths: paths.flatMap((path) => [caseKey(path), ...(fs.pathKey ? [fs.pathKey(path)] : [])]),
      identities,
      exclusive:
        c.op === 'move' ||
        c.op === 'delete' ||
        c.prev_path !== null ||
        (entry !== null && entry.wirePath !== c.path),
    })
  }
  return result
}

/** All admitted work is drained. A failed predecessor releases its successors,
 * which reject instead of publishing acknowledgements. No fixed-size cohort. */
export async function placeWave(
  changes: ChangeItem[],
  signal: AbortSignal | undefined,
  work: (
    change: ChangeItem,
    settle: (completedSerial?: boolean) => Promise<void>,
    signal: AbortSignal
  ) => Promise<void>
): Promise<void> {
  const stop = new AbortController()
  const activeSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  let previous = Promise.resolve()
  let failure: { error: unknown } | undefined
  const tasks: Promise<void>[] = []
  for (const change of changes) {
    if (activeSignal.aborted) break
    const before = previous
    let release!: () => void
    previous = new Promise<void>((resolve) => {
      release = resolve
    })
    const settle = async (completedSerial = false) => {
      await before
      if (failure) throw failure.error
      if (!completedSerial) checkCancellation(activeSignal)
    }
    tasks.push(
      (async () => {
        try {
          checkCancellation(activeSignal)
          await work(change, settle, activeSignal)
        } catch (error) {
          failure ??= { error }
          stop.abort(error)
        } finally {
          // Even a failed early preparation cannot let successors pass the row
          // preceding it, whose filesystem work may still be in flight.
          await before
          release()
        }
      })()
    )
  }
  await Promise.all(tasks)
  checkCancellation(signal)
  if (failure) throw failure.error
  checkCancellation(activeSignal)
}
