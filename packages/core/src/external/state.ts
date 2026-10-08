import type { StateEntry } from '../state.js'
import { z } from 'zod'
import {
  ConnectionBindingSchema,
  ExternalDocumentSchema,
  ExternalOperationSchema,
  ExternalRecordSchema,
  sameConnection,
  type ConnectionBinding,
  type ExternalDocument,
  type ExternalOperation,
  type ExternalRecord,
} from './records.js'

export type ExternalStateReason =
  | 'unsupported-storage'
  | 'nested-transaction'
  | 'revision-conflict'
  | 'binding-mismatch'
  | 'operation-mismatch'
  | 'aborted'
  | 'commit-unknown'
  | 'recovery-required'
export class ExternalStateError extends Error {
  constructor(
    readonly reason: ExternalStateReason,
    options?: { cause?: unknown }
  ) {
    super(`External state: ${reason}`, options)
    this.name = 'ExternalStateError'
  }
}
export const EXTERNAL_STATE_KEY = 'external-files'
export interface ExternalLedgerChanges {
  putEntries?: StateEntry[]
  deletePaths?: string[]
  cursor?: number
  /** Existing personal/scoped metadata, through the host's existing namespace. */
  metadata?: { key: string; value: string | null }[]
}
export interface ExternalPhaseBatch {
  expectedRevision: number | null
  next: string
  ledger?: ExternalLedgerChanges
}
/** Data-only phase transaction: no user callback, filesystem or network actions. */
export interface ExternalStatePort {
  readonly externalDurability: 'durable'
  getExternalState(): Promise<string | null>
  commitExternalPhase(batch: ExternalPhaseBatch): Promise<void>
}
export interface ExternalChange {
  expectedRevision: number
  files?: { expectedRevision: number | null; next: ExternalRecord }[]
  operations?: { expectedRevision: number | null; next: ExternalOperation }[]
  ledger?: ExternalLedgerChanges
}
const path = z.string().min(1).max(4096)
const ledgerSchema = z
  .object({
    putEntries: z
      .array(
        z
          .object({
            path,
            wirePath: path,
            fileId: z.string().min(1),
            versionId: z.string().min(1),
            sha: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            mtime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .strict()
      )
      .optional(),
    deletePaths: z.array(path).optional(),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    metadata: z
      .array(
        z
          .object({
            key: z
              .string()
              .min(1)
              .max(256)
              .refine((key) => key !== EXTERNAL_STATE_KEY),
            value: z.string().nullable(),
          })
          .strict()
      )
      .optional(),
  })
  .strict()
export function prepareExternalLedger(input: unknown): ExternalLedgerChanges {
  return ledgerSchema.parse(input ?? {})
}
export function decodeExternalDocument(raw: string): ExternalDocument {
  try {
    return ExternalDocumentSchema.parse(JSON.parse(raw))
  } catch (cause) {
    throw new ExternalStateError('recovery-required', { cause })
  }
}
/** Check against the actual database transaction, not an earlier overlay snapshot. */
export function checkExternalPhase(
  batch: ExternalPhaseBatch,
  current: string | null
): { next: ExternalDocument; ledger: ExternalLedgerChanges } {
  const next = decodeExternalDocument(batch.next)
  const previous = current === null ? null : decodeExternalDocument(current)
  if (
    (previous?.revision ?? null) !== batch.expectedRevision ||
    next.revision !== (batch.expectedRevision === null ? 0 : batch.expectedRevision + 1)
  )
    throw new ExternalStateError('revision-conflict')
  if (
    previous &&
    (next.ledgerId !== previous.ledgerId || !sameConnection(next.binding, previous.binding))
  )
    throw new ExternalStateError('binding-mismatch')
  return { next, ledger: prepareExternalLedger(batch.ledger) }
}

/** Shared facade for durable host ports. Memory is never a production fallback. */
export class ExternalState {
  private unknownCommit = false
  private constructor(
    private readonly port: ExternalStatePort,
    private readonly ledgerId: string,
    readonly binding: ConnectionBinding
  ) {}
  static async open(
    port: ExternalStatePort,
    ledgerId: string,
    input: unknown
  ): Promise<ExternalState> {
    if (
      port.externalDurability !== 'durable' ||
      typeof port.getExternalState !== 'function' ||
      typeof port.commitExternalPhase !== 'function'
    )
      throw new ExternalStateError('unsupported-storage')
    const binding = ConnectionBindingSchema.parse(input)
    const state = new ExternalState(port, ledgerId, Object.freeze(binding))
    const raw = await port.getExternalState()
    if (raw === null) {
      const document = ExternalDocumentSchema.parse({
        schema: 1,
        ledgerId,
        binding,
        revision: 0,
        files: [],
        operations: [],
      })
      await port.commitExternalPhase({ expectedRevision: null, next: JSON.stringify(document) })
    } else state.assertBinding(decodeExternalDocument(raw))
    return state
  }
  private assertBinding(document: ExternalDocument): void {
    if (document.ledgerId !== this.ledgerId || !sameConnection(document.binding, this.binding))
      throw new ExternalStateError('binding-mismatch')
  }
  async snapshot(): Promise<ExternalDocument> {
    const raw = await this.port.getExternalState()
    if (raw === null) throw new ExternalStateError('recovery-required')
    const document = decodeExternalDocument(raw)
    this.assertBinding(document)
    return document
  }
  /** Receipt only after the host confirms its underlying database COMMIT. */
  async commit(change: ExternalChange): Promise<{ status: 'committed'; revision: number }> {
    if (this.unknownCommit) throw new ExternalStateError('recovery-required')
    const document = await this.snapshot()
    if (document.revision !== change.expectedRevision)
      throw new ExternalStateError('revision-conflict')
    const seenFiles = new Set<string>()
    for (const update of change.files ?? []) {
      const next = ExternalRecordSchema.parse(update.next)
      const previous = document.files.find((file) => file.fileId === next.fileId)
      if (
        seenFiles.has(next.fileId) ||
        (previous?.localRevision ?? null) !== update.expectedRevision ||
        next.localRevision !== (update.expectedRevision === null ? 0 : update.expectedRevision + 1)
      )
        throw new ExternalStateError('revision-conflict')
      seenFiles.add(next.fileId)
      if (
        previous?.lastProvenLocalBase &&
        (previous.pendingOperationId || previous.retained.length) &&
        JSON.stringify(previous.lastProvenLocalBase) !== JSON.stringify(next.lastProvenLocalBase)
      )
        throw new ExternalStateError('recovery-required')
      if (previous) document.files[document.files.indexOf(previous)] = next
      else document.files.push(next)
    }
    const seenOperations = new Set<string>()
    for (const update of change.operations ?? []) {
      const next = ExternalOperationSchema.parse(update.next)
      const previous = document.operations.find((op) => op.operationId === next.operationId)
      if (
        seenOperations.has(next.operationId) ||
        (previous?.revision ?? null) !== update.expectedRevision ||
        next.revision !== (update.expectedRevision === null ? 0 : update.expectedRevision + 1)
      )
        throw new ExternalStateError('revision-conflict')
      seenOperations.add(next.operationId)
      if (
        previous &&
        JSON.stringify(operationParameters(previous)) !== JSON.stringify(operationParameters(next))
      )
        throw new ExternalStateError('operation-mismatch')
      if (previous) document.operations[document.operations.indexOf(previous)] = next
      else document.operations.push(next)
    }
    document.revision++
    const next = JSON.stringify(ExternalDocumentSchema.parse(document))
    const ledger = prepareExternalLedger(change.ledger)
    try {
      await this.port.commitExternalPhase({
        expectedRevision: change.expectedRevision,
        next,
        ledger,
      })
    } catch (cause) {
      if (!(cause instanceof ExternalStateError) || cause.reason === 'commit-unknown') {
        this.unknownCommit = true
        throw new ExternalStateError('commit-unknown', { cause })
      }
      throw cause
    }
    return { status: 'committed', revision: document.revision }
  }
}
function operationParameters(op: ExternalOperation): unknown {
  return {
    operationId: op.operationId,
    kind: op.kind,
    connectionGeneration: op.connectionGeneration,
    expected: op.expected,
    sourcePath: op.sourcePath,
    targetPath: op.targetPath,
    previousRepresentation: op.previousRepresentation,
    localBase: op.localBase,
    desiredRepresentation: op.desiredRepresentation,
    desiredAvailability: op.desiredAvailability,
  }
}
