import { V2ChangeSchema, type V2Change } from '@abele/sync-protocol'
import type { StateEntry, StateStore } from './state.js'
import type { EngineClient } from './engineClient.js'
import { commitAppliedSettlement } from './settlement.js'
import { firstSettlementSequence, indexSettlement, sequenceKey } from './settlementIndex.js'
import { checkCancellation } from './cancellation.js'
import type { FileSystem } from './fs.js'
import type { FileRetries } from './fileRetry.js'
import { DEPARTURE_MARK, writeDepartureMark } from './departureMarks.js'

export interface DepartureEvent {
  connection: string
  generation: string | null
  event: Extract<V2Change, { type: 'removal' }>
  /** Authoritative later membership event, never a baseline-change guess. */
  supersededBy?: Extract<V2Change, { type: 'content' }>
}
export interface DepartureObligation extends DepartureEvent {
  base: StateEntry | null
  pending: boolean
  sourceIdentity?: string
}
export type MembershipEvent = Omit<DepartureEvent, 'event' | 'supersededBy'> & {
  event: Extract<V2Change, { type: 'content' }>
}
const membershipKey = (fileId: string) => 'settlement-membership:' + encodeURIComponent(fileId)
const key = (sequence: number) => 'settlement-departure:row:' + sequenceKey(sequence)

function contentProof(event: unknown): Extract<V2Change, { type: 'content' }> {
  const proof = V2ChangeSchema.parse(event)
  if (
    proof.type !== 'content' ||
    proof.item.file_id !== proof.file_id ||
    proof.item.path !== proof.path
  )
    throw new Error('invalid departure membership proof')
  return proof
}

function decodeMembership(raw: string): MembershipEvent {
  const proof = JSON.parse(raw) as MembershipEvent
  if (
    !proof ||
    typeof proof.connection !== 'string' ||
    !(proof.generation === null || typeof proof.generation === 'string')
  )
    throw new Error('invalid departure membership proof')
  contentProof(proof.event)
  return proof
}

export function decodeDeparture(raw: string): DepartureObligation {
  const row = JSON.parse(raw) as DepartureObligation
  if (
    !row ||
    typeof row.pending !== 'boolean' ||
    typeof row.connection !== 'string' ||
    !(row.generation === null || typeof row.generation === 'string') ||
    V2ChangeSchema.parse(row.event).type !== 'removal' ||
    (row.sourceIdentity !== undefined && typeof row.sourceIdentity !== 'string') ||
    (row.base !== null &&
      (!row.base ||
        row.base.fileId !== row.event.file_id ||
        typeof row.base.path !== 'string' ||
        typeof row.base.wirePath !== 'string' ||
        typeof row.base.versionId !== 'string' ||
        typeof row.base.sha !== 'string' ||
        !Number.isSafeInteger(row.base.size) ||
        !Number.isSafeInteger(row.base.mtime)))
  )
    throw new Error('invalid departure obligation')
  if (row.supersededBy) {
    const proof = contentProof(row.supersededBy)
    if (proof.file_id !== row.event.file_id || proof.cursor <= row.event.cursor)
      throw new Error('invalid departure supersession proof')
  }
  return row
}

/** Capturing transport metadata never invokes a host or filesystem effect. */
export async function captureDepartures(
  state: StateStore,
  events: readonly DepartureEvent[],
  fs?: FileSystem,
  memberships: readonly MembershipEvent[] = []
) {
  if (!events.length && !memberships.length) return
  if (!state.setMeta || !state.getMeta) throw new Error('departure settlement requires metadata')
  const observations = new Map<
    DepartureEvent,
    { base: StateEntry | null; sourceIdentity?: string }
  >()
  for (const item of events) {
    const base = await state.byFileId(item.event.file_id)
    const sourceIdentity = base ? await fs?.fileIdentity?.(base.path) : undefined
    observations.set(item, { base, ...(sourceIdentity == null ? {} : { sourceIdentity }) })
  }
  await commitAppliedSettlement(
    state,
    async () => ({ reached: await state.getCursor(), firstUnresolved: null }),
    async (tx) => {
      for (const membership of memberships) {
        const name = membershipKey(membership.event.file_id)
        const raw = await tx.getMeta!(name)
        const old = raw === null ? null : decodeMembership(raw)
        if (
          old?.connection === membership.connection &&
          old.generation === membership.generation &&
          old.event.cursor >= membership.event.cursor
        )
          continue
        await tx.setMeta!(name, JSON.stringify(membership))
        await writeDepartureMark(tx, DEPARTURE_MARK, membership.event.path, false)
      }
      for (const item of events) {
        const name = key(item.event.cursor)
        const raw = await tx.getMeta!(name)
        if (raw !== null) {
          const old = decodeDeparture(raw)
          if (old.connection === item.connection && old.generation === item.generation) {
            if (JSON.stringify(old.event) !== JSON.stringify(item.event))
              throw new Error('departure identity changed')
            continue
          }
          if (old.pending) throw new Error('unresolved departure from another namespace')
        }
        const observed = observations.get(item)!
        if (JSON.stringify(await tx.byFileId(item.event.file_id)) !== JSON.stringify(observed.base))
          throw new Error('departure source changed during capture')
        const row: DepartureObligation = {
          ...item,
          ...observed,
          pending: true,
        }
        await tx.setMeta!(name, JSON.stringify(row))
        await indexSettlement(tx, item.event.cursor, true)
      }
    }
  )
}

/** One bounded ordered dispatch pass. False leaves the exact obligation replayable.
 * Host effects run outside the short resolution transaction. */
export async function dispatchDepartures(
  state: StateStore,
  client: Pick<EngineClient, 'settleDeparture'>,
  signal?: AbortSignal,
  limit = 1000,
  retries?: FileRetries
): Promise<void> {
  for (let count = 0; count < limit; count++) {
    checkCancellation(signal)
    const sequence = await firstSettlementSequence(state)
    if (sequence === null) return
    const raw = await state.getMeta?.(key(sequence))
    if (!raw) throw new Error('missing departure obligation')
    const row = decodeDeparture(raw)
    if (!row.pending || row.event.cursor !== sequence)
      throw new Error('invalid departure obligation')
    if (retries && !retries.ready(row.event.path, 'departure')) return
    const member = await state.getMeta?.(membershipKey(row.event.file_id))
    if (member) {
      const proof = decodeMembership(member)
      if (proof.event.file_id !== row.event.file_id)
        throw new Error('departure membership proof names another identity')
      if (
        proof.connection === row.connection &&
        proof.generation === row.generation &&
        proof.event.cursor > sequence
      )
        row.supersededBy = proof.event
    }
    const publish = await client.settleDeparture?.(row, signal)
    checkCancellation(signal)
    const wait = () =>
      commitAppliedSettlement(
        state,
        async () => ({ reached: await state.getCursor(), firstUnresolved: null }),
        async (tx) => {
          if ((await tx.getMeta!(key(sequence))) !== raw) return
          await retries?.failed(
            row.event.path,
            'departure',
            new Error('connection departure awaits host handling or local authority'),
            false,
            tx,
            key(sequence)
          )
        }
      )
    if (!publish) {
      if (retries) await wait()
      return
    }
    checkCancellation(signal)
    await commitAppliedSettlement(
      state,
      async () => ({ reached: await state.getCursor(), firstUnresolved: null }),
      async (tx) => {
        if ((await tx.getMeta!(key(sequence))) !== raw) throw new Error('departure owner changed')
        if (!(await publish(tx))) return
        await tx.setMeta!(key(sequence), JSON.stringify({ ...row, pending: false }))
        await indexSettlement(tx, sequence, false)
        await retries?.succeeded(row.event.path, 'departure', tx)
        checkCancellation(signal)
      }
    )
    // A failed publication check must not spin on the same owner this pass.
    if ((await firstSettlementSequence(state)) === sequence) {
      if (retries) await wait()
      return
    }
  }
}
