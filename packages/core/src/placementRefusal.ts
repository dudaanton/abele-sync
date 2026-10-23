import type { ChangeItem } from '@abele/sync-protocol'
import type { EngineClient } from './engineClient.js'
import type { StateEntry, StateStore } from './state.js'
import { storedDirectoryRefusal } from './v2Directories.js'

/** One gate for pull, approval, direct placement and pending-write recovery. */
export async function placementRefusal(
  client: Pick<EngineClient, 'pathRefusal'>,
  state: StateStore,
  change: ChangeItem,
  entry: StateEntry | null
) {
  const paths = new Set(
    [change.path, entry?.path, entry?.wirePath, change.prev_path].filter(
      (path): path is string => path != null
    )
  )
  for (const path of paths) {
    const refusal = client.pathRefusal?.(path)
    if (refusal) return refusal
  }
  return storedDirectoryRefusal(state, paths)
}
