import type { ChangeItem } from '@abele/sync-protocol'
import type { EngineClient } from './engineClient.js'
import type { StateEntry, StateStore } from './state.js'
import { storedDirectoryRefusal } from './v2Directories.js'

/** One gate for pull, approval, direct placement and pending-write recovery. */
export async function placementRefusal(
  client: Pick<EngineClient, 'pathRefusal'>,
  state: StateStore,
  change: Pick<ChangeItem, 'path' | 'prev_path'>,
  entry: StateEntry | null
) {
  const paths = new Set(
    [change.path, entry?.path, entry?.wirePath, change.prev_path].filter(
      (path): path is string => path != null
    )
  )
  return pathRefusal(client, state, paths)
}

export async function pathRefusal(
  client: Pick<EngineClient, 'pathRefusal'>,
  state: StateStore,
  paths: Iterable<string>
) {
  const names = [...paths]
  for (const path of names) {
    const refusal = client.pathRefusal?.(path)
    if (refusal) return refusal
  }
  return storedDirectoryRefusal(state, names)
}
