import { PullHolds } from './pullHolds.js'
import type { StateStore } from './state.js'
import type { WaitingFile } from './fileRetry.js'
import { waitingDirectories } from './v2Directories.js'

/** Detached metadata snapshots. Reading never probes the filesystem or retries work. */
export async function incomingWaiting(state: StateStore): Promise<WaitingFile[]> {
  const holds = new PullHolds(
    state,
    'pull-refused-progress',
    (id) => `pull-refused:${encodeURIComponent(id)}`
  )
  await holds.load()
  const files: WaitingFile[] = []
  for (const { change, reason } of holds.records.values()) {
    if (reason === undefined) continue
    files.push({
      path: change.path,
      fileId: change.file_id,
      versionId: change.version_id,
      seq: change.seq,
      reason,
      phase: 'pull',
      attempts: 1,
      nextAt: 0,
      quarantined: true,
      owner: `pull-refused:${encodeURIComponent(change.file_id)}`,
    })
  }
  return [...files, ...(await waitingDirectories(state))]
}

export async function waitingSnapshot(
  state: StateStore,
  retries: WaitingFile[]
): Promise<WaitingFile[]> {
  const incoming = await incomingWaiting(state)
  const paths = new Set(incoming.map((row) => row.path))
  return [...retries.filter((row) => !paths.has(row.path)), ...incoming]
}
