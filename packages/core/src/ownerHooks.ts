import { z } from 'zod'
import {
  CommitOpSchema,
  type CommitOp,
  type CommitOpResult,
  type VersionInfo,
} from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import type { Journal, StateStore } from './state.js'
import type { VaultClient } from './client.js'
import { sha256 } from './hash.js'
export interface OwnerUploadUnit extends Journal {
  operations: readonly { handle: string; index: number; op: CommitOp }[]
}
export interface OwnerSettlement {
  handle: string
  index: number
  op: CommitOp
  result: CommitOpResult
  creation: 'novel' | 'adopted' | 'collision' | 'unknown'
  fileId: string
  versionId: string
  path: string
  sha: string | null
  size: number
  mtime: number
}
export interface OwnerPushHooks {
  beforeUpload?: (unit: OwnerUploadUnit) => Promise<void | { holdIndices: readonly number[] }>
  onSettled?: (item: OwnerSettlement, bytes: Uint8Array | null, requestId: string) => Promise<void>
}
const HeldSchema = z
  .array(
    z
      .object({
        batchId: z.string(),
        ops: z.array(CommitOpSchema).max(1000),
        idempotencyKey: z.string(),
        startedAt: z.string(),
        publicationPhase: z.enum(['prepared', 'submitted']).optional(),
        ownerBinding: z
          .object({
            issuer: z.string(),
            vaultId: z.string(),
            credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
        operationIndices: z.array(z.number().int().nonnegative()).max(1000).optional(),
      })
      .strict()
  )
  .max(64)
const HELD = 'owner-publication-held'
export async function heldOwnerUnits(state: StateStore, enabled: boolean): Promise<Journal[]> {
  if (!enabled) return []
  if (!state.getMeta || !state.setMeta)
    throw new EngineError('io', 'owner publication hooks need durable metadata')
  const raw = await state.getMeta(HELD)
  if (raw === null) return []
  if (raw.length > 2 * 1024 * 1024)
    throw new EngineError('io', 'owner publication hold bound exceeded')
  try {
    return HeldSchema.parse(JSON.parse(raw))
  } catch (cause) {
    throw new EngineError('io', 'owner publication hold recovery required', cause)
  }
}
export async function saveOwnerHold(state: StateStore, journal: Journal): Promise<void> {
  const held = await heldOwnerUnits(state, true),
    next = held.filter((unit) => unit.idempotencyKey !== journal.idempotencyKey)
  next.push(journal)
  if (next.length > 64 || next.reduce((sum, unit) => sum + unit.ops.length, 0) > 1000)
    throw new EngineError('io', 'owner publication hold budget reached')
  await state.setMeta!(HELD, JSON.stringify(next))
}
export async function dropOwnerHold(state: StateStore, key: string): Promise<void> {
  const held = await heldOwnerUnits(state, true)
  await state.setMeta!(HELD, JSON.stringify(held.filter((unit) => unit.idempotencyKey !== key)))
}
export function ownerUnit(journal: Journal): OwnerUploadUnit {
  return {
    ...structuredClone(journal),
    operations: journal.ops.map((op, index) => ({
      handle: `${journal.batchId}:${journal.operationIndices?.[index] ?? index}`,
      index,
      op: structuredClone(op),
    })),
  }
}
export function expandOwnerHolds(
  ops: readonly CommitOp[],
  indices: readonly number[]
): Set<number> {
  const held = new Set(indices)
  if ([...held].some((index) => !Number.isInteger(index) || index < 0 || index >= ops.length))
    throw new EngineError('protocol', 'invalid publication hold indices')
  const ids = new Set(
    [...held].flatMap((index) => {
      const op = ops[index]!
      return op.op === 'move' || op.op === 'modify' ? [op.file_id] : []
    })
  )
  ops.forEach((op, index) => {
    if ((op.op === 'move' || op.op === 'modify') && ids.has(op.file_id)) held.add(index)
  })
  return held
}
export async function settleOwnerUnit(
  client: VaultClient,
  journal: Journal,
  ops: readonly CommitOp[],
  results: readonly CommitOpResult[],
  hook: NonNullable<OwnerPushHooks['onSettled']>,
  indexMap?: readonly number[],
  creations?: readonly { index: number; kind: 'novel' | 'adopted' | 'collision' }[]
) {
  for (const [index, result] of results.entries()) {
    const op = ops[index]
    if (!op) throw new EngineError('protocol', 'missing settlement operation')
    if (result.status === 'rejected') continue
    let bytes: Uint8Array | null = null
    if (result.sha !== null) {
      bytes = await client.getBlob(result.sha)
      if (bytes.length !== result.size || (await sha256(bytes)) !== result.sha)
        throw new EngineError('protocol', 'owner settled content integrity mismatch')
    }
    const original = indexMap?.[index] ?? journal.operationIndices?.[index] ?? index
    await hook(
      {
        handle: `${journal.batchId}:${original}`,
        index: original,
        op: structuredClone(op),
        result: structuredClone(result),
        creation:
          op.op === 'create'
            ? (creations?.find((item) => item.index === index)?.kind ?? 'unknown')
            : 'unknown',
        fileId: result.file_id,
        versionId: result.version_id,
        path: result.path,
        sha: result.sha,
        size: result.size,
        mtime: result.mtime,
      },
      bytes,
      journal.idempotencyKey
    )
  }
}
