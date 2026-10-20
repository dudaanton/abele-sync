import type { Generated } from 'kysely'
import type { V2Selector } from '@abele/sync-protocol'

export interface UsersTable {
  id: string
  label: string
  created_at: string
  disabled_at: string | null
}
export interface SpacesTable {
  name: Generated<string>
  deleted_at: string | null
  id: string
  user_id: string
  settings: string
  address: string
  created_at: string
}
export interface DirectoriesTable {
  id: string
  space_id: string
  parent_id: string | null
  path: string
  version_id: string
  seq: Generated<number>
  mtime: number
  deleted_at: string | null
}
export interface AccessScopesTable {
  id: string
  space_id: string
  kind: V2Selector['kind']
  target_id: string
  boundary_scope_id: string | null
  effective_key: string
}
export interface AccessTokensTable {
  scope_deleted_at: string | null
  last_used_at: string | null
  last_address: string | null
  address_status: Generated<string>
  read_only: Generated<number>
  id: string
  space_id: string
  secret_hash: string
  scope_id: string
  issued_by_token_id: string | null
  label: string
  created_at: string
  revoked_at: string | null
}
export interface AccessDatabase {
  access_token_items: {
    id: string
    token_id: string
    scope_id: string
    added_by_token_id: string | null
    added_at: string
    removed_at: string | null
  }
  scope_deletions: { secret_hash: string; deleted_at: string }
  activity_daily: {
    vault_id: string
    token_id: string
    day: string
    uploaded_files: Generated<number>
    uploaded_bytes: Generated<number>
    downloaded_files: Generated<number>
    downloaded_bytes: Generated<number>
    commits: Generated<number>
  }
  group_notes: { space_id: string; file_id: string; path: string; signature: string }
  group_write_bases: { token_id: string; file_id: string; version_id: string }
  group_names: { space_id: string; name: string; file_id: string; exact: number }
  group_links: { space_id: string; source_id: string; link: string; target_id: string | null }
  group_assets: {
    space_id: string
    root_id: string
    file_id: string
    published_by: string
    published_at: string
  }
  group_copies: { space_id: string; original_id: string; file_id: string }
  users: UsersTable
  spaces: SpacesTable
  directories: DirectoriesTable
  access_scopes: AccessScopesTable
  access_tokens: AccessTokensTable
  scope_members: { scope_id: string; file_id: string; item: string }
  scope_versions: { scope_id: string; file_id: string; version_id: string }
  scope_changes: {
    scope_id: string
    cursor: number
    type: 'content' | 'removal' | 'delete'
    event: string
  }
  scope_snapshots: { id: string; scope_id: string; cursor: number; expires_at: string }
  scope_snapshot_items: { snapshot_id: string; file_id: string; item: string }
}
