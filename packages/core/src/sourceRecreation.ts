import type { StateEntry, StateStore } from './state.js'
import { wirePath } from './localPaths.js'

/** An absent tracked source reappeared while its offline move target was observed.
 * Keep the old ledger until a scan classifies the move and the independent create. */
export interface SourceRecreation {
  base: StateEntry
  target: string
}

export const sourceRecreationKey = (id: string) => `pull-source-recreated:${id}`

/** Match the portable destination, including when its physical spelling is now
 * absent. This transfers ledger ownership only; content checks still own writes. */
export function isRecreatedTarget(record: SourceRecreation | null, path: string): boolean {
  return record !== null && wirePath(record.target) === wirePath(path)
}

export async function sourceRecreation(
  state: StateStore,
  base: StateEntry
): Promise<SourceRecreation | null> {
  const raw = await state.getMeta?.(sourceRecreationKey(base.fileId))
  if (!raw) return null
  const record = JSON.parse(raw) as SourceRecreation
  return typeof record.target === 'string' &&
    record.target !== base.path &&
    record.base &&
    (['path', 'wirePath', 'fileId', 'versionId', 'sha', 'size', 'mtime'] as const).every(
      (field) => record.base[field] === base[field]
    )
    ? record
    : null
}
