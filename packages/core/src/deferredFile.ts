import type { Staged } from './defer.js'

/** Durable deferred-decision document, shared with stage-retirement publication. */
export const DEFERRED_KEY = 'deferred-changes'

export interface Filed {
  staged: Staged[]
}

/**
 * The records as filed. An older build also filed `keptDeletes` — deletes it let past the
 * delete guard — and those are read as nothing: such a delete, if the scan still finds it, is
 * then judged by the guard like any other.
 */
export function parse(raw: string | null): Filed {
  if (raw === null) return { staged: [] }
  try {
    const value = JSON.parse(raw) as Partial<Filed> | null
    if (value === null || typeof value !== 'object') return { staged: [] }
    const staged = Array.isArray(value.staged)
      ? value.staged.filter(
          (one): one is Staged =>
            typeof one === 'object' &&
            one !== null &&
            typeof one.change === 'object' &&
            one.change !== null &&
            typeof one.change.file_id === 'string' &&
            typeof one.change.path === 'string' &&
            (one.base === null || typeof one.base === 'string')
        )
      : []
    return { staged }
  } catch {
    return { staged: [] }
  }
}
