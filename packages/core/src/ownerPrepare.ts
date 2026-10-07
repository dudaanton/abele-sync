import type { CommitOp } from '@abele/sync-protocol'
import type { Journal, StateStore } from './state.js'
import {
  dropOwnerHold,
  saveOwnerHold,
  ownerUnit,
  expandOwnerHolds,
  type OwnerPushHooks,
} from './ownerHooks.js'
/** A partial release has exactly one durable transition: replace the source
 * hold, store its remaining subset under a fresh key, and persist the sending
 * subset under the original never-submitted key in the same transaction.
 */
export async function prepareOwnerJournal(
  state: StateStore,
  journal: Journal,
  hook: OwnerPushHooks['beforeUpload']
): Promise<{ journal: Journal | null; held: CommitOp[] }> {
  if (!hook || journal.publicationPhase === 'submitted') return { journal, held: [] }
  const decision = await hook(ownerUnit(journal)),
    indices = expandOwnerHolds(journal.ops, decision?.holdIndices ?? [])
  if (!indices.size) return { journal, held: [] }
  const heldIndices = [...indices].sort((a, b) => a - b),
    sendingIndices = journal.ops.map((_op, index) => index).filter((index) => !indices.has(index))
  const subset = (indices: number[]): Journal => ({
    ...journal,
    ops: indices.map((index) => journal.ops[index]!),
    operationIndices: indices.map((index) => journal.operationIndices?.[index] ?? index),
  })
  const heldJournal = {
      ...subset(heldIndices),
      idempotencyKey: sendingIndices.length ? crypto.randomUUID() : journal.idempotencyKey,
    },
    sendingJournal = sendingIndices.length ? subset(sendingIndices) : null
  await state.transaction(async () => {
    await dropOwnerHold(state, journal.idempotencyKey)
    await saveOwnerHold(state, heldJournal)
    await state.setJournal(sendingJournal)
  })
  return { journal: sendingJournal, held: heldJournal.ops }
}
