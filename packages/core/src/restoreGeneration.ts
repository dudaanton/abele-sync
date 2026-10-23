import { transact } from './stateTransaction.js'
import type { StateEntry, StateStore } from './state.js'
import { readReconciliation, requestReconciliation } from './reconciliation.js'

export const GENERATION_KEY = 'server-restore-generation'
export const RECONCILING_KEY = 'server-restore-reconciling'
export const MEMBERS_KEY = 'server-restore-members'
const RESET_KEYS = [
  'pull-held-progress',
  'pull-refused-progress',
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
    ...entries.map((entry) => `pull-source-recreated:${entry.fileId}`),
    ...((await state.metadataKeys?.('pull-source-recreated:')) ?? []),
    ...((await state.metadataKeys?.('pull-write:')) ?? []),
    ...((await state.metadataKeys?.('pull-evict:')) ?? []),
    ...((await state.metadataKeys?.('pull-held:')) ?? []),
    ...((await state.metadataKeys?.('pull-refused:')) ?? []),
    ...((await state.metadataKeys?.('push-receipt:')) ?? []),
    ...((await state.metadataKeys?.('file-retry:')) ?? []),
    ...((await state.metadataKeys?.('pull-applied:')) ?? []),
  ])
  // The linked index also supports hosts without metadata enumeration.
  for (const prefix of ['pull-held', 'pull-refused']) {
    const held = JSON.parse((await state.getMeta(`${prefix}-progress`)) ?? 'null') as {
      first?: string | null
    } | null
    const seenHolds = new Set<string>()
    for (let id = held?.first ?? null; id !== null;) {
      if (seenHolds.has(id)) throw new Error('cyclic pull hold index')
      seenHolds.add(id)
      const key = `${prefix}:${encodeURIComponent(id)}`
      pullKeys.add(key)
      const node = JSON.parse((await state.getMeta(key)) ?? 'null') as {
        next: string | null
      } | null
      id = node?.next ?? null
    }
  }
  const recovering =
    old !== null ||
    entries.length > 0 ||
    pullKeys.size > 0 ||
    (await state.getJournal()) !== null ||
    (await state.getCursor()) > 0
  await transact(state, async (tx) => {
    if (recovering) {
      const localReconciliation = await readReconciliation(tx)
      const metadata: Record<string, string | null> = {}
      const resetKeys = new Set([...RESET_KEYS, ...pullKeys])
      for (const key of resetKeys) metadata[key] = await tx.getMeta!(key)
      await tx.setMeta!(
        `retired-generation:${old ?? 'legacy'}`,
        JSON.stringify({
          entries,
          cursor: await tx.getCursor(),
          journal: await tx.getJournal(),
          metadata,
        })
      )
      for (const entry of entries) await tx.delete(entry.path)
      await tx.setJournal(null)
      await tx.setCursor(0)
      for (const key of resetKeys) await tx.setMeta!(key, null)
      await tx.setMeta!(RECONCILING_KEY, generation)
      const members = new Map<string, StateEntry>()
      for (const entry of JSON.parse(metadata[MEMBERS_KEY] ?? '[]') as StateEntry[])
        members.set(entry.wirePath, entry)
      for (const entry of entries) members.set(entry.wirePath, entry)
      await tx.setMeta!(MEMBERS_KEY, JSON.stringify([...members.values()]))
      await requestReconciliation(
        tx,
        `server generation changed${
          localReconciliation && localReconciliation.phase !== 'complete'
            ? `; ${localReconciliation.reason}`
            : ''
        }`
      )
    }
    await tx.setMeta!(GENERATION_KEY, generation)
  })
  return recovering
}
