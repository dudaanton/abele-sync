import type { CommitOp, JoinPrefer } from '@abele/sync-protocol'

/**
 * The scan's ops as the pusher sends them: cut into commits the protocol takes, with a move and
 * its modify never parted, and every create carrying the side a joining device chose.
 */

/** Bound unrecorded first-upload work; an indivisible file/pair may exceed the byte limit. */
export const PUSH_BATCH_LIMITS = { operations: 100, bytes: 8 * 1024 * 1024 } as const

/** The ops, with every create carrying the side a joining device chose, if it chose one. */
export function preferring(ops: CommitOp[], prefer: JoinPrefer | undefined): CommitOp[] {
  if (prefer === undefined) return ops
  return ops.map((op) => (op.op === 'create' ? { ...op, prefer } : op))
}

/**
 * The scan's ops cut into commits the protocol will take, in the order the scan put them
 * in: deletes and moves first, so a move lands on a path this very batch frees, then
 * modifies, then creates.
 *
 * A boundary never falls between a move and the modify that belongs with it. The scanner
 * emits both against the version before the move, and a modify sent in a later commit would
 * be measured against a base the move has already superseded — the server settles that in
 * the client's favour, but there is no reason to make it. The two are not adjacent as the
 * scan hands them over, so a rename that came with an edit is drawn up to sit directly
 * behind its move first; everything else keeps the order it had.
 */
export function batches(ops: CommitOp[]): CommitOp[][] {
  const paired = pairUp(ops)
  const out: CommitOp[][] = []
  let batch: CommitOp[] = [],
    bytes = 0
  for (let at = 0; at < paired.length;) {
    const group = paired.slice(at, at + (isPair(paired[at], paired[at + 1]) ? 2 : 1))
    const size = group.reduce((sum, op) => sum + ('size' in op ? op.size : 0), 0)
    if (
      batch.length &&
      (batch.length + group.length > PUSH_BATCH_LIMITS.operations ||
        bytes + size > PUSH_BATCH_LIMITS.bytes)
    ) {
      out.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(...group)
    bytes += size
    at += group.length
  }
  if (batch.length) out.push(batch)
  return out
}

/**
 * The same ops, with every modify that belongs to a move brought up behind it. Nothing is
 * reordered across anything it depends on: a modify only ever moves earlier, and only to a
 * place after the move of its own file, which the scan already put before every modify.
 */
function pairUp(ops: CommitOp[]): CommitOp[] {
  const modifies = new Map<string, number>()
  for (const [at, op] of ops.entries()) {
    if (op.op === 'modify' && !modifies.has(op.file_id)) modifies.set(op.file_id, at)
  }
  const drawn = new Set<number>()
  const out: CommitOp[] = []
  for (const [at, op] of ops.entries()) {
    if (!drawn.has(at)) out.push(op)
    if (op.op !== 'move') continue
    const mate = modifies.get(op.file_id)
    const modify = mate === undefined ? undefined : ops[mate]
    if (mate === undefined || mate <= at || modify === undefined) continue
    drawn.add(mate)
    out.push(modify)
  }
  return out
}

/** Whether the second op is the modify that came with the first op's move. */
const isPair = (move: CommitOp | undefined, modify: CommitOp | undefined): boolean =>
  move?.op === 'move' && modify?.op === 'modify' && move.file_id === modify.file_id
