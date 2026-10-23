import type { CommitOp } from '@abele/sync-protocol'
import type { Refusal, RejectedOp } from './pusher.js'
import type { StateStore } from './state.js'

/** Blob refusals are cached by content; user-facing context belongs to each operation. */
export async function rejectedOp(
  state: StateStore,
  op: CommitOp,
  refusal: Refusal,
  maxFileBytes?: number
): Promise<RejectedOp> {
  const entry = op.op === 'create' ? null : await state.byFileId(op.file_id)
  const path = op.op === 'create' ? op.path : op.op === 'move' ? op.to_path : entry?.wirePath
  const size = 'size' in op ? op.size : entry?.size
  const details = refusal.details
  // A body/route ceiling may be lower than the advertised per-file ceiling.
  // Only use the learned file limit when these bytes actually exceed it.
  const fileLimit =
    size !== undefined && maxFileBytes !== undefined && size > maxFileBytes
      ? maxFileBytes
      : undefined
  const rawLimit =
    refusal.code === 'too_large'
      ? (details?.max_bytes ?? details?.max_file_bytes ?? fileLimit)
      : details?.quota_bytes
  const limit =
    typeof rawLimit === 'number' && Number.isSafeInteger(rawLimit) && rawLimit >= 0
      ? rawLimit
      : null
  const context =
    refusal.code === 'too_large' && size !== undefined
      ? ` (${size} bytes; limit ${limit === null ? 'unknown' : `${limit} bytes`})`
      : ''
  return {
    op,
    code: refusal.code,
    message: path === undefined ? refusal.message : `${path}${context}: ${refusal.message}`,
    ...(path === undefined ? {} : { path }),
    ...(size === undefined ? {} : { size, limit }),
  }
}
