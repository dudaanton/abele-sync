import type { Generated } from 'kysely'

export type ScopedRole = 'reader' | 'editor'
interface Lifecycle {
  created_at: string
  expires_at: string | null
  revoked_at: string | null
}
export interface AccountAuthorityTable {
  account_id: string
  revision: Generated<number>
}
export interface ScopeGrantsTable extends Lifecycle {
  id: string
  vault_id: string
  owner_account_id: string
  label: string
  selector_kind: 'folder' | 'group'
  folder_prefix: string | null
  root_file_id: string | null
  role: ScopedRole
  state: Generated<'preparing' | 'active' | 'unavailable'>
  acl_revision: Generated<number>
  scope_revision: Generated<number>
  publication_revision: Generated<number>
  created_session_hash: string | null
  authenticated_at: string | null
}
export interface ScopeMembersTable extends Lifecycle {
  id: string
  grant_id: string
  account_id: string
  role: ScopedRole
  authority_revision: Generated<number>
}
export interface ScopeKeysTable extends Lifecycle {
  id: string
  grant_id: string
  owner_account_id: string
  name: string
  token_hash: string
  role: ScopedRole
  authority_revision: Generated<number>
  expires_at: string
  last_seen_at: string | null
}
export interface ScopeInstallationsTable extends Lifecycle {
  id: string
  grant_id: string
  member_id: string
  account_id: string
  name: string
  platform: 'desktop' | 'mobile' | 'daemon'
  token_hash: string
  role: ScopedRole
  authority_revision: Generated<number>
  last_seen_at: string | null
}
export interface ScopeInvitationsTable extends Lifecycle {
  id: string
  grant_id: string
  token_hash: string
  intended_account_id: string | null
  role: ScopedRole
  expires_at: string
  accepted_account_id: string | null
  accepted_member_id: string | null
  accepted_at: string | null
}
export interface ScopeAcceptanceResultsTable {
  invitation_id: string
  grant_id: string
  account_id: string
  member_id: string
  request_hash: string
  created_at: string
  expires_at: string
}
export interface ScopeEnrolmentResultsTable {
  account_id: string
  attempt_id: string
  grant_id: string
  member_id: string
  installation_id: string
  request_hash: string
  protected_token: string | null
  created_at: string
  expires_at: string
  retired_at: string | null
}
export interface ScopeKeyIssuancesTable {
  account_id: string
  grant_id: string
  attempt_id: string
  key_id: string
  request_hash: string
  protected_token: string | null
  session_hash: string
  authenticated_at: string
  created_at: string
  expires_at: string
  retired_at: string | null
}
/** Polymorphic columns are FK/shape fenced; no nullable legacy device fallback. */
export interface ScopedOwnership {
  vault_id: string
  grant_id: string
  principal_kind: 'key' | 'installation'
  principal_id: string
  key_id: string | null
  installation_id: string | null
}
export interface ScopeUploadsTable extends ScopedOwnership {
  id: string
  sha: string
  size: number
  part_size: number
  parts_received: string
  created_at: string
  expires_at: string
  completing_at: string | null
}
export interface ScopeBlobUploadsTable extends ScopedOwnership {
  sha: string
  size: number
  created_at: string
  expires_at: string | null
}
export interface ScopeReceiptsTable extends ScopedOwnership {
  endpoint_identity: string
  request_id: string
  request_hash: string
  outcome_id: string
  status: number
  response: string | null
  created_at: string
  payload_expires_at: string
}
/** Minimal source IDs deliberately outlive payload retention; missing/null is unknown. */
export interface VersionSecuritySourcesTable {
  version_id: string
  vault_id: string
  file_id: string
  writer_facet: 'device' | 'scoped' | 'system' | 'unknown'
  writer_principal_id: string | null
  writer_account_id: string | null
  writer_grant_id: string | null
  executable: 0 | 1 | null
  settings: 0 | 1 | null
  source_version_ids: string
  /** Bounded ancestry namespaces survive payload GC and later configuration registration. */
  source_namespaces: Generated<string | null>
  recorded_at: string
}
export interface AuthorityDatabase {
  account_authority: AccountAuthorityTable
  scope_grants: ScopeGrantsTable
  scope_members: ScopeMembersTable
  scope_keys: ScopeKeysTable
  scope_installations: ScopeInstallationsTable
  scope_invitations: ScopeInvitationsTable
  scope_acceptance_results: ScopeAcceptanceResultsTable
  scope_enrolment_results: ScopeEnrolmentResultsTable
  scope_key_issuances: ScopeKeyIssuancesTable
  scope_uploads: ScopeUploadsTable
  scope_blob_uploads: ScopeBlobUploadsTable
  scope_receipts: ScopeReceiptsTable
  version_security_sources: VersionSecuritySourcesTable
}
