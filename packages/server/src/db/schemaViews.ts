import type { Generated } from 'kysely'
import type { ScopedOwnership } from './schemaAuthority.js'

interface FileScope {
  grant_id: string
  vault_id: string
  file_id: string
}
export interface ScopeAdmissionIntervalsTable extends FileScope {
  id: string
  generation: number
  intrinsic: 0 | 1
  baseline_version_id: string
  admitted_at: string
  ended_at: string | null
  end_reason: 'deleted' | 'departed' | 'unknown' | null
}
export interface ScopeVersionAdmissionsTable extends FileScope {
  interval_id: string
  generation: number
  version_id: string
  admitted_at: string
}
interface SafeHead {
  version_id: string
  path: string
  kind: 'note' | 'canvas' | 'attachment'
  sha: string | null
  size: number
  mtime: number
}
export interface ScopeCurrentMembersTable extends FileScope, SafeHead {
  interval_id: string
}
export interface ScopeTrashTable extends FileScope {
  interval_id: string
  last_version_id: string
  deleted_version_id: string
  deleted_at: string
  expires_at: string
  eligible: Generated<0 | 1>
}
export interface ScopeFeedStateTable {
  grant_id: string
  generation: Generated<number>
  position: Generated<number>
  minimum_position: Generated<number>
  updated_at: string
}
export interface ScopeFeedTable {
  grant_id: string
  generation: number
  position: number
  event_type: 'content' | 'deleted' | 'departed' | 'policy'
  file_id: string | null
  interval_id: string | null
  version_id: string | null
  safe_payload: string
  at: string
}
export interface ScopeSnapshotsTable extends ScopedOwnership {
  id: string
  scope_revision: number
  acl_revision: number
  publication_revision: number
  feed_generation: number
  feed_position: number
  row_count: number
  state: Generated<'paging' | 'complete' | 'invalidated'>
  created_at: string
  expires_at: string
}
export interface ScopeSnapshotItemsTable extends FileScope, SafeHead {
  snapshot_id: string
  ordinal: number
  interval_id: string
  sha: string
}
export interface ScopeSnapshotPinsTable extends FileScope {
  snapshot_id: string
  version_id: string
  sha: string
}
export interface ScopeFolderPreparationsTable {
  grant_id: string
  vault_id: string
  phase: 'capture' | 'replay' | 'complete' | 'unavailable'
  start_seq: number
  inventory_cursor: string | null
  replay_seq: number
  created_at: string
  updated_at: string
  expires_at: string
}
export interface ScopeGroupAnchorsTable extends FileScope {
  owner_account_id: string
  approved_device_id: string
  approved_at: string
  approval_version_id: string
}
export interface ScopeGroupOriginsTable {
  id: string
  vault_id: string
  source_file_id: string
  token_key: string
  introduced_version_id: string
  introduced_at: string
  origin_kind: 'owner_personal' | 'grant_native' | 'recipient' | 'unknown'
  writer_facet: 'device' | 'scoped' | 'unknown'
  writer_principal_id: string | null
  writer_account_id: string | null
  origin_grant_id: string | null
  target_file_id: string | null
}
export interface ScopeGroupBindingsTable {
  vault_id: string
  source_file_id: string
  token_key: string
  origin_id: string
  target_file_id: string | null
  state: 'unresolved' | 'bound' | 'tombstoned'
  approved_rebind_id: string | null
}
export interface ScopeGroupParseFactsTable {
  vault_id: string
  file_id: string
  version_id: string
  status: 'valid' | 'invalid' | 'unknown' | 'limited'
  facts: string
  committed_seq: number
  recorded_at: string
}
export interface ScopeGroupDirtyTable {
  vault_id: string
  committed_seq: number
  ordinal: number
  file_id: string
  version_id: string
  operation: string
  lineage: string
  created_at: string
}
export interface ScopeGroupProgressTable {
  vault_id: string
  processed_seq: Generated<number>
  generation: Generated<number>
  bootstrap_start_seq: number | null
  bootstrap_cursor: string | null
  status: 'preparing' | 'ready' | 'unavailable'
  updated_at: string
}
export interface ScopeGroupLeasesTable {
  id: string
  vault_id: string
  start_seq: number
  created_at: string
  expires_at: string
}
export interface ScopeGroupPinsTable {
  lease_id: string
  vault_id: string
  file_id: string
  version_id: string
}
export interface ScopeExtraEntriesTable extends FileScope {
  id: string
  origin: 'owner' | 'native'
  first_version_id: string
  generation: number
  withdrawal_generation: Generated<number>
  owner_device_id: string | null
  reason: 'initial_batch' | 'new_local_file' | 'confirmed_existing_file' | 'native_create' | null
  created_at: string
  withdrawn_at: string | null
}
export interface ScopeExtraSponsorsTable {
  entry_id: string
  grant_id: string
  vault_id: string
  note_id: string
  interval_id: string
  admission_generation: number
  intrinsic: 1
  added_at: string
}
export interface ScopePublicationOutcomesTable {
  grant_id: string
  owner_device_id: string
  intent_id: string
  request_hash: string
  publication_revision: number
  withdrawal_generation: number
  outcome: string | null
  created_at: string
  payload_expires_at: string
}
export interface ScopeNativeFilesTable extends FileScope {
  creator_kind: 'key' | 'installation'
  creator_id: string
  created_version_id: string
  kind: 'note' | 'canvas' | 'attachment'
  created_at: string
}
export interface ViewsDatabase {
  scope_admission_intervals: ScopeAdmissionIntervalsTable
  scope_version_admissions: ScopeVersionAdmissionsTable
  scope_current_members: ScopeCurrentMembersTable
  scope_trash: ScopeTrashTable
  scope_feed_state: ScopeFeedStateTable
  scope_feed: ScopeFeedTable
  scope_snapshots: ScopeSnapshotsTable
  scope_snapshot_items: ScopeSnapshotItemsTable
  scope_snapshot_pins: ScopeSnapshotPinsTable
  scope_folder_preparations: ScopeFolderPreparationsTable
  scope_group_anchors: ScopeGroupAnchorsTable
  scope_group_origins: ScopeGroupOriginsTable
  scope_group_bindings: ScopeGroupBindingsTable
  scope_group_parse_facts: ScopeGroupParseFactsTable
  scope_group_dirty: ScopeGroupDirtyTable
  scope_group_progress: ScopeGroupProgressTable
  scope_group_leases: ScopeGroupLeasesTable
  scope_group_pins: ScopeGroupPinsTable
  scope_extra_entries: ScopeExtraEntriesTable
  scope_extra_sponsors: ScopeExtraSponsorsTable
  scope_publication_outcomes: ScopePublicationOutcomesTable
  scope_native_files: ScopeNativeFilesTable
}
