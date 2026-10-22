import { caseKey } from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { StateEntry, StateStore } from './state.js'

/** Resolve authority by the host's name equivalence, not by requested spelling.
 * Prefer a foreign owner even when an exact row for this identity also exists:
 * legacy duplicate rows must fail closed. Always use the current transaction. */
export async function pathOccupant(
  fs: FileSystem | undefined,
  state: StateStore,
  path: string,
  fileId: string
): Promise<StateEntry | null> {
  const key = fs?.pathKey ? (path: string) => fs.pathKey!(path) : caseKey
  const target = key(path)
  let own: StateEntry | null = null
  for await (const entry of state.pathCandidates?.(path) ?? state.all()) {
    if (key(entry.path) !== target) continue
    if (entry.fileId !== fileId) return entry
    own = entry
  }
  return own
}
