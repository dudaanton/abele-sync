import type { StateEntry, StateStore } from './state.js'
import { readReconciliation, requestReconciliation } from './reconciliation.js'

export const GENERATION_KEY = 'server-restore-generation'
export const RECONCILING_KEY = 'server-restore-reconciling'
export const MEMBERS_KEY = 'server-restore-members'
const RESET_KEYS = [
  'pull-manifest-progress',
  'pull-manifest-page',
  'v2-local-note-cache',
  'scan-hint-epoch',
  'v2-directories',
  'v2-departures',
  'v2-authored-departures',
  'held-deletes',
  'delete-decision',
  'recent-deletes',
  'held-noted',
  'out-of-scope-files',
  'passed-over-paths',
  'deferred-changes',
  'join-open',
  MEMBERS_KEY,
  RECONCILING_KEY,
  'content-reconciliation',
  'content-missing',
  'content-sweep-after',
]

/** Retire old authority, never disk bytes. A fresh manifest adopts identical files,
 * preserves divergent local copies and publishes files absent from the restored server.
 * The old journal is evidence, never a replay into the restored receipt namespace. */
export async function reconcileGeneration(state: StateStore, generation: string | undefined) {
  if (generation === undefined) return false // old server: unchanged behavior
  if (!state.getMeta || !state.setMeta)
    throw new Error('restore generation requires durable metadata')
  const old = await state.getMeta(GENERATION_KEY)
  if (old === generation) return false
  const entries: StateEntry[] = []
  for await (const entry of state.all()) entries.push(entry)
  const pullKeys = new Set([
    ...entries.map((entry) => `pull-write:${entry.fileId}`),
    ...((await state.metadataKeys?.('pull-write:')) ?? []),
    ...((await state.metadataKeys?.('pull-evict:')) ?? []),
  ])
  const recovering =
    old !== null ||
    entries.length > 0 ||
    pullKeys.size > 0 ||
    (await state.getJournal()) !== null ||
    (await state.getCursor()) > 0
  await state.transaction(async () => {
    if (recovering) {
      const localReconciliation = await readReconciliation(state)
      const metadata: Record<string, string | null> = {}
      const resetKeys = new Set([...RESET_KEYS, ...pullKeys])
      for (const key of resetKeys) metadata[key] = await state.getMeta!(key)
      await state.setMeta!(
        `retired-generation:${old ?? 'legacy'}`,
        JSON.stringify({
          entries,
          cursor: await state.getCursor(),
          journal: await state.getJournal(),
          metadata,
        })
      )
      for (const entry of entries) await state.delete(entry.path)
      await state.setJournal(null)
      await state.setCursor(0)
      for (const key of resetKeys) await state.setMeta!(key, null)
      await state.setMeta!(RECONCILING_KEY, generation)
      const members = new Map<string, StateEntry>()
      for (const entry of JSON.parse(metadata[MEMBERS_KEY] ?? '[]') as StateEntry[])
        members.set(entry.wirePath, entry)
      for (const entry of entries) members.set(entry.wirePath, entry)
      await state.setMeta!(MEMBERS_KEY, JSON.stringify([...members.values()]))
      await requestReconciliation(
        state,
        `server generation changed${
          localReconciliation && localReconciliation.phase !== 'complete'
            ? `; ${localReconciliation.reason}`
            : ''
        }`
      )
    }
    await state.setMeta!(GENERATION_KEY, generation)
  })
  return recovering
}
