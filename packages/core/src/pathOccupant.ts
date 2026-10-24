import { caseKey } from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { StateEntry, StateStore } from './state.js'

const keys = new WeakMap<FileSystem, (path: string) => string>()
function hostKey(fs: FileSystem | undefined): (path: string) => string {
  if (!fs?.pathKey) return caseKey
  let key = keys.get(fs)
  if (!key) {
    key = fs.pathKey.bind(fs)
    keys.set(fs, key)
  }
  return key
}

/** Resolve authority by the host's name equivalence, not by requested spelling.
 * Prefer a foreign owner even when an exact row for this identity also exists:
 * legacy duplicate rows must fail closed. Always use the current transaction. */
export async function pathOccupant(
  fs: FileSystem | undefined,
  state: StateStore,
  path: string,
  fileId: string
): Promise<StateEntry | null> {
  const key = hostKey(fs)
  const target = key(path)
  let own: StateEntry | null = null
  const work = new ScanWork()
  for await (const entry of state.pathCandidates?.(path, key) ?? state.all()) {
    await work.step()
    if (key(entry.path) !== target) continue
    if (entry.fileId !== fileId) return entry
    own = entry
  }
  return own
}
import { ScanWork } from './scanWork.js'
