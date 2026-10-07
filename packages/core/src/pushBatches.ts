import type { CommitOp, JoinPrefer } from '@abele/sync-protocol'

/**
 * The scan's ops as the pusher sends them: cut into commits the protocol takes, with a move and
 * its modify never parted, and every create carrying the side a joining device chose.
 */

/** The largest batch a commit takes, per the protocol. */
const MAX_OPS = 1000

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
  let at = 0
  while (at < paired.length) {
    let end = Math.min(at + MAX_OPS, paired.length)
    // Never cut a pair in half; a pair is two ops, so a chunk of 1 000 can always spare one.
    if (end < paired.length && isPair(paired[end - 1], paired[end]) && end - 1 > at) end -= 1
    out.push(paired.slice(at, end))
    at = end
  }
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
