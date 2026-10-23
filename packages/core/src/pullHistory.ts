import type { ChangeItem } from '@abele/sync-protocol'
import type { StateEntry, StateStore } from './state.js'
import { GENERATION_KEY } from './restoreGeneration.js'
import { EngineError } from './errors.js'

export const pullHistoryKey = (id: string) => `pull-applied:${encodeURIComponent(id)}`
interface Applied {
  generation: string | null
  seq: number
  version: string
  absent: boolean
}

/** Baseline evidence, not another cursor or work queue. A pinned cursor can replay
 * old pages after a later version landed. Opaque version ids alone cannot order them. */
export async function olderPull(
  state: StateStore,
  change: ChangeItem,
  entry: StateEntry | null
): Promise<boolean> {
  const raw = await state.getMeta?.(pullHistoryKey(change.file_id))
  if (raw == null) return false
  const applied = JSON.parse(raw) as Applied
  if (
    !applied ||
    !(applied.generation === null || typeof applied.generation === 'string') ||
    !Number.isSafeInteger(applied.seq) ||
    applied.seq < 0 ||
    typeof applied.version !== 'string' ||
    typeof applied.absent !== 'boolean'
  )
    throw new EngineError('io', 'invalid pull application evidence')
  return (
    applied.generation === ((await state.getMeta?.(GENERATION_KEY)) ?? null) &&
    change.seq < applied.seq &&
    (applied.absent ? entry === null : entry?.versionId === applied.version)
  )
}

/** Publish only in the same transaction as its ledger outcome. */
export async function recordPull(
  state: StateStore,
  change: ChangeItem,
  absent = false
): Promise<void> {
  await state.setMeta?.(
    pullHistoryKey(change.file_id),
    JSON.stringify({
      generation: (await state.getMeta?.(GENERATION_KEY)) ?? null,
      seq: change.seq,
      version: change.version_id,
      absent,
    } satisfies Applied)
  )
}
