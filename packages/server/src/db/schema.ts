import type { Generated } from 'kysely'
import type { AuthorityDatabase } from './schemaAuthority.js'
import type { ViewsDatabase } from './schemaViews.js'
import type { Actor, FileKind, VersionOp } from '@abele/sync-protocol'

/**
 * The server's storage schema. Timestamps are ISO-8601 strings in UTC, `mtime`
 * is integer milliseconds, sizes are integer bytes and JSON columns are text.
 */

export interface AccountsTable {
  id: string
  email: string
  password_hash: string
  created_at: string
  disabled_at: string | null
}

export interface AccountTokensTable {
  token_hash: string
  account_id: string
  expires_at: string
  /** Null legacy sessions cannot establish fresh owner authentication. */
  issued_at: Generated<string | null>
}

export interface VaultsTable {
  id: string
  owner_account_id: string
  name: string
  /** JSON: VaultSettings. */
  settings: string
  created_at: string
}

export interface VaultMembersTable {
  vault_id: string
  account_id: string
  role: string
}

export interface VaultSeqTable {
  vault_id: string
  head_seq: number
  epoch: Generated<number>
}

export interface DevicesTable {
  id: string
  account_id: string
  vault_id: string
  name: string
  platform: string
  token_hash: string
  /** JSON: the device's selective-sync rules. */
  selective: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
  /** The device whose token enrolled this one (`POST /v1/devices/self/siblings`); null for an account's. */
  enrolled_by: string | null
}

export interface FilesTable {
  id: string
  vault_id: string
  path: string
  /** The case-folded path, unique per vault while the file is live. */
  path_ci: string
  kind: FileKind
  head_version_id: string | null
  deleted_at: string | null
}

/** The vault retention setting a version is measured against for its whole lifetime. */
export type RetentionClass = 'notes' | 'attachments' | 'settings'

export interface VersionsTable {
  id: string
  file_id: string
  vault_id: string
  seq: number
  no: number
  op: VersionOp
  path: string
  /** Migration 010 backfills canonical JS keys; absent out-of-band keys cannot authorize group resolution. */
  path_ci: Generated<string | null>
  prev_path: string | null
  blob_sha: string | null
  size: number
  mtime: number
  actor_kind: Actor['kind']
  actor_id: string
  actor_name: string
  created_at: string
  prev_version_id: string | null
  /** JSON: merge provenance, null when the version was not a merge. */
  merge: string | null
  /** Immutable policy class; null means unknown, so retention must keep the version. */
  retention_class: RetentionClass | null
}

export interface BlobsTable {
  sha: string
  size: number
  storage_ref: string
  refs: number
  created_at: string
  last_referenced_at: string
}

export interface UploadsTable {
  id: string
  sha: string
  size: number
  part_size: number
  /** JSON: the part numbers received so far. */
  parts_received: string
  created_at: string
  /** The vault and device the upload is for (`006_upload_owners`); null on older rows. */
  vault_id: string | null
  device_id: string | null
  /** When its completion began: from then on no part may change. Null until then. */
  completing_at: string | null
}

/** An upload no version of its vault names yet, one row per device waiting on it (`006`). */
export interface BlobUploadsTable {
  vault_id: string
  sha: string
  /** A device that sent these bytes to this vault and has not committed them. */
  device_id: string
  size: number
  created_at: string
}

export interface IdempotencyTable {
  actor_id: string
  key: string
  request_hash: string
  status: number
  /** JSON: the recorded response body. */
  response: string
  created_at: string
}

export interface AuditTable {
  id: string
  vault_id: string
  /** Wider than Actor['kind']: the audit log also records account-level actions. */
  actor_kind: string
  actor_id: string
  action: string
  path: string | null
  result: string
  at: string
  /** JSON: free-form detail for the entry. */
  details: string
}

export interface UsageDailyTable {
  vault_id: string
  day: string
  live_bytes: number
  history_bytes: number
  trash_bytes: number
  /** JSON: per-kind byte and count totals. */
  by_kind: string
}

export interface Database extends AuthorityDatabase, ViewsDatabase {
  accounts: AccountsTable
  account_tokens: AccountTokensTable
  vaults: VaultsTable
  vault_members: VaultMembersTable
  vault_seq: VaultSeqTable
  devices: DevicesTable
  files: FilesTable
  versions: VersionsTable
  blobs: BlobsTable
  uploads: UploadsTable
  blob_uploads: BlobUploadsTable
  idempotency: IdempotencyTable
  audit: AuditTable
  usage_daily: UsageDailyTable
}
