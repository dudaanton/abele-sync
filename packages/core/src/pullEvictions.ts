import { transact } from './stateTransaction.js'
import { normalisePath, validatePath } from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { StateEntry, StateStore } from './state.js'
import { EngineError } from './errors.js'
import { checkCancellation } from './cancellation.js'

export const evictionKey = (fileId: string) => `pull-evict:${fileId}`
export async function recoverPullEvictions(
  fs: FileSystem,
  state: StateStore,
  signal?: AbortSignal
): Promise<void> {
  const keys = (await state.metadataKeys?.('pull-evict:')) ?? []
  if (!state.metadataKeys)
    for await (const entry of state.all()) keys.push(evictionKey(entry.fileId))
  for (const key of keys) {
    checkCancellation(signal)
    const raw = await state.getMeta?.(key)
    if (!raw) continue
    let base: StateEntry
    try {
      base = JSON.parse(raw) as StateEntry
      validatePath(normalisePath(base.path))
      if (evictionKey(base.fileId) !== key) throw new Error('identity mismatch')
    } catch (error) {
      throw new EngineError('io', 'invalid pull eviction intent', error)
    }
    const entry = await state.get(base.path)
    const same =
      entry !== null &&
      (['path', 'wirePath', 'fileId', 'versionId', 'sha', 'size', 'mtime'] as const).every(
        (field) => entry[field] === base[field]
      )
    const absent = (await fs.stat(base.path)) === null
    await transact(state, async (tx) => {
      if (same && absent) await tx.delete(base.path)
      await tx.setMeta?.(key, null)
    })
  }
}
