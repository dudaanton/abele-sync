import type {
  Actor,
  CommitOp,
  MergeInfo,
  Principal,
  VaultSettings,
  VersionOp,
} from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { BlobStore } from '../blobs/store.js'
import type { Database } from '../db/schema.js'
import type { BaseKnowledge, HeadState } from './resolve.js'

/**
 * What every step of one commit shares (see `commit.ts`): the batch's context, the head an op
 * meets as it was loaded, the version row about to be written, and the faults that are the
 * server's own rather than the client's.
 */

/** The ops that carry bytes of their own. */
export type ContentOp = Extract<CommitOp, { sha: string }>

/** What every step of one batch shares: the transaction, the vault and who is committing. */
export interface Ctx {
  trx: Transaction<Database>
  store: BlobStore
  vaultId: string
  actor: Actor
  settings: VaultSettings
  at: Date
  writer?: Principal
  configurationDirectories?: readonly string[]
  /** Scoped output/security check before any admission or payload publication. */
  authorizeOutput?: (version: NewVersion, versionId: string) => Promise<void>
  /** Null means preserve incoming authorized history rather than create a new identity. */
  conflictDestination?: (wanted: string) => Promise<string | null>
  restoreDestination?: (wanted: string) => Promise<string>
  /** Scoped uploads are consumed by their principal, never by personal vault-wide GC. */
  scopedWriter?: boolean
  nativeSponsorId?: string
  allowGroupConflictCopy?: boolean
  /** Exact destinations certified before this fenced context starts writing. */
  authorizedDestinations?: Set<string>
}

/** `HeadState` plus the head version's seq, which the results that write nothing report. */
export interface LoadedHead extends HeadState {
  seq: number
}

/** A version row about to be written, in the words of the pipeline rather than the table. */
export interface NewVersion {
  fileId: string
  op: VersionOp
  path: string
  prevPath: string | null
  sha: string | null
  size: number
  mtime: number
  no: number
  prevVersionId: string | null
  merge: MergeInfo | null
  /** Explicit restore/copy/base lineage, not inferred from the output actor or SHA. */
  securitySourceVersionIds?: readonly string[]
}

/** The base a merge of this op records: the op's own, when the vault still has it. */
export const mergeBase = (op: CommitOp, baseIsKnown: BaseKnowledge): string | null =>
  op.op === 'modify' && baseIsKnown === 'yes' ? op.base_version_id : null

/**
 * A row the server cannot make sense of. A plain error, not an `AbeleError`:
 * the handler logs the reason and answers the bare `internal` envelope, so the
 * client learns nothing about the rows and the batch is rolled back whole.
 */
export const corrupt = (reason: string): Error => new Error(reason)

/** A live head always has bytes; one without is a broken row, not a client mistake. */
export function requireSha(head: LoadedHead): string {
  if (head.sha === null) throw corrupt(`version ${head.versionId} has no blob`)
  return head.sha
}

/** A decision that names the head cannot have been made without one. */
export function mustExist(head: LoadedHead | null): LoadedHead {
  if (head === null) throw corrupt('a decision about a head that was not loaded')
  return head
}
