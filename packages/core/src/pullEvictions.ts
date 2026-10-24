import { pathOccupant } from './pathOccupant.js'
import { commitRemoval } from './removalRetention.js'
import { commitAppliedSettlement } from './settlement.js'
import { replayAuthority } from './replayAuthority.js'
import { normalisePath, validatePath } from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { StateEntry, StateStore } from './state.js'
import { EngineError } from './errors.js'
import { checkCancellation } from './cancellation.js'
import { isFileFailure, type FileRetries } from './fileRetry.js'
import { pathRefusal } from './placementRefusal.js'
import type { EngineClient } from './engineClient.js'

export const evictionKey = (fileId: string) => `pull-evict:${fileId}`
export async function recoverPullEvictions(
  fs: FileSystem,
  state: StateStore,
  signal?: AbortSignal,
  retries?: FileRetries,
  client: Pick<EngineClient, 'pathRefusal'> = {}
): Promise<void> {
  const keys = (await state.metadataKeys?.('pull-evict:')) ?? []
  const work = new ScanWork({ signal })
  if (!state.metadataKeys)
    for await (const entry of state.all()) {
      await work.step()
      keys.push(evictionKey(entry.fileId))
    }
  for (const key of keys) {
    await work.step()
    checkCancellation(signal)
    const raw = await state.getMeta?.(key)
    if (!raw) continue
    if (retries && !retries.ready(key)) continue
    let base: StateEntry
    try {
      base = JSON.parse(raw) as StateEntry
      validatePath(normalisePath(base.path))
      if (evictionKey(base.fileId) !== key) throw new Error('identity mismatch')
    } catch (error) {
      if (retries) {
        await retries.failed(key, 'recovery', error, true)
        continue
      }
      throw new EngineError('io', 'invalid pull eviction intent', error)
    }
    if (retries && !retries.ready(base.wirePath)) continue
    if (await pathRefusal(client, state, [base.path, base.wirePath])) continue
    try {
      await commitAppliedSettlement(
        state,
        async () => ({ reached: await state.getCursor(), firstUnresolved: null }),
        async (tx) => {
          // A different intent or baseline is not proof that this eviction settled.
          if ((await tx.getMeta?.(key)) !== raw) return
          if (await pathRefusal(client, tx, [base.path, base.wirePath])) return
          const entry = await pathOccupant(fs, tx, base.path, base.fileId)
          const same =
            replayAuthority(base.fileId, base, await tx.byFileId(base.fileId), entry) &&
            entry !== null &&
            (['path', 'wirePath', 'fileId', 'versionId', 'sha', 'size', 'mtime'] as const).every(
              (field) => entry[field] === base[field]
            )
          if (!same || (await fs.stat(base.path)) !== null) return
          checkCancellation(signal)
          await tx.delete(base.path)
          await commitRemoval(tx, base, fs)
          await tx.setMeta?.(key, null)
          await retries?.succeeded(base.wirePath, 'recovery', tx, key)
          await retries?.succeeded(key, 'recovery', tx, key)
          checkCancellation(signal)
        }
      )
    } catch (error) {
      checkCancellation(signal)
      if (!retries || !isFileFailure(error)) throw error
      await retries.failed(base.wirePath, 'recovery', error)
    }
  }
}
import { ScanWork } from './scanWork.js'
