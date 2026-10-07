import type { Kysely } from 'kysely'
import { principalColumns, principalConstraints, scopedSql } from './scopedSql.js'

/** Lean authority only. No content parsing, security guesses or unrestricted membership. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('account_tokens').addColumn('issued_at', 'text').execute()
  await scopedSql(db, authorityStatements)
}

export const authorityStatements = [
  `create unique index vaults_owner_identity on vaults(id,owner_account_id)`,
  `create table account_authority (account_id text primary key references accounts(id),
    revision bigint not null default 0 check(revision >= 0))`,
  `insert into account_authority(account_id) select id from accounts`,
  `create table scope_grants (
    id text primary key, vault_id text not null, owner_account_id text not null,
    label text not null, selector_kind text not null check(selector_kind in ('folder','group')),
    folder_prefix text, root_file_id text, role text not null check(role in ('reader','editor')),
    state text not null default 'preparing' check(state in ('preparing','active','unavailable')),
    acl_revision bigint not null default 0 check(acl_revision >= 0),
    scope_revision bigint not null default 0 check(scope_revision >= 0),
    publication_revision bigint not null default 0 check(publication_revision >= 0),
    created_at text not null, expires_at text, revoked_at text,
    created_session_hash text, authenticated_at text,
    unique(id,vault_id), unique(id,owner_account_id),
    foreign key(vault_id,owner_account_id) references vaults(id,owner_account_id),
    check((selector_kind = 'folder' and folder_prefix is not null and length(folder_prefix) > 1 and
      substr(folder_prefix,length(folder_prefix),1) = '/' and root_file_id is null) or
      (selector_kind = 'group' and root_file_id is not null and folder_prefix is null)))`,
  `create index scope_grants_vault on scope_grants(vault_id,revoked_at,selector_kind)`,
  `create table scope_members (
    id text primary key, grant_id text not null references scope_grants(id),
    account_id text not null references accounts(id), role text not null check(role in ('reader','editor')),
    authority_revision bigint not null default 0 check(authority_revision >= 0),
    created_at text not null, expires_at text, revoked_at text, unique(id,grant_id,account_id))`,
  `create unique index scope_members_live on scope_members(grant_id,account_id) where revoked_at is null`,
  `create index scope_members_account on scope_members(account_id,revoked_at)`,
  `create table scope_keys (
    id text primary key, grant_id text not null, owner_account_id text not null,
    name text not null, token_hash text not null unique, role text not null check(role in ('reader','editor')),
    authority_revision bigint not null default 0 check(authority_revision >= 0),
    created_at text not null, expires_at text not null, revoked_at text, last_seen_at text,
    unique(id,grant_id), foreign key(grant_id,owner_account_id) references scope_grants(id,owner_account_id),
    check(expires_at > created_at))`,
  `create index scope_keys_grant on scope_keys(grant_id,revoked_at)`,
  `create table scope_installations (
    id text primary key, grant_id text not null, member_id text not null, account_id text not null,
    name text not null, platform text not null check(platform in ('desktop','mobile','daemon')),
    token_hash text not null unique, role text not null check(role in ('reader','editor')),
    authority_revision bigint not null default 0 check(authority_revision >= 0),
    created_at text not null, expires_at text, revoked_at text, last_seen_at text,
    unique(id,grant_id), unique(id,grant_id,member_id,account_id),
    foreign key(member_id,grant_id,account_id) references scope_members(id,grant_id,account_id))`,
  `create index scope_installations_member on scope_installations(member_id,revoked_at)`,
  `create table scope_invitations (
    id text primary key, grant_id text not null references scope_grants(id), token_hash text not null unique,
    intended_account_id text references accounts(id), role text not null check(role in ('reader','editor')),
    created_at text not null, expires_at text not null, revoked_at text,
    accepted_account_id text, accepted_member_id text, accepted_at text, unique(id,grant_id),
    foreign key(accepted_member_id,grant_id,accepted_account_id) references scope_members(id,grant_id,account_id),
    check(expires_at > created_at),
    check((accepted_account_id is null and accepted_member_id is null and accepted_at is null) or
      (accepted_account_id is not null and accepted_member_id is not null and accepted_at is not null)))`,
  `create index scope_invitations_grant on scope_invitations(grant_id,expires_at)`,
  `create table scope_acceptance_results (
    invitation_id text primary key, grant_id text not null, account_id text not null, member_id text not null,
    request_hash text not null, created_at text not null, expires_at text not null,
    foreign key(invitation_id,grant_id) references scope_invitations(id,grant_id),
    foreign key(member_id,grant_id,account_id) references scope_members(id,grant_id,account_id), check(expires_at > created_at))`,
  `create index scope_acceptance_expiry on scope_acceptance_results(expires_at)`,
  `create table scope_enrolment_results (
    account_id text not null, attempt_id text not null, grant_id text not null, member_id text not null,
    installation_id text not null, request_hash text not null, protected_token text,
    created_at text not null, expires_at text not null, retired_at text, primary key(account_id,attempt_id),
    foreign key(installation_id,grant_id,member_id,account_id) references scope_installations(id,grant_id,member_id,account_id),
    check(expires_at > created_at))`,
  `create index scope_enrolment_expiry on scope_enrolment_results(expires_at)`,
  `create table scope_key_issuances (
    account_id text not null, grant_id text not null, attempt_id text not null, key_id text not null,
    request_hash text not null, protected_token text, session_hash text not null, authenticated_at text not null,
    created_at text not null, expires_at text not null, retired_at text,
    primary key(account_id,grant_id,attempt_id),
    foreign key(grant_id,account_id) references scope_grants(id,owner_account_id),
    foreign key(key_id,grant_id) references scope_keys(id,grant_id), check(expires_at > created_at))`,
  `create index scope_key_issuance_expiry on scope_key_issuances(expires_at)`,
  `create table scope_uploads (
    id text primary key, vault_id text not null, grant_id text not null, ${principalColumns},
    sha text not null, size bigint not null check(size >= 0), part_size bigint not null check(part_size > 0),
    parts_received text not null, created_at text not null, expires_at text not null, completing_at text,
    ${principalConstraints}, check(expires_at > created_at))`,
  `create index scope_upload_owner on scope_uploads(principal_kind,principal_id,grant_id)`,
  `create index scope_upload_expiry on scope_uploads(expires_at)`,
  `create table scope_blob_uploads (
    vault_id text not null, grant_id text not null, ${principalColumns}, sha text not null,
    size bigint not null check(size >= 0), created_at text not null, expires_at text,
    primary key(vault_id,sha,principal_kind,principal_id), ${principalConstraints})`,
  `create index scope_blob_entitlement on scope_blob_uploads(grant_id,principal_kind,principal_id)`,
  `create table scope_receipts (
    vault_id text not null, grant_id text not null, ${principalColumns},
    endpoint_identity text not null, request_id text not null, request_hash text not null,
    outcome_id text not null, status integer not null check(status between 100 and 599),
    response text, created_at text not null, payload_expires_at text not null,
    primary key(principal_kind,principal_id,endpoint_identity,request_id), ${principalConstraints},
    check(payload_expires_at > created_at))`,
  `create index scope_receipt_expiry on scope_receipts(payload_expires_at)`,
  `create table version_security_sources (
    version_id text primary key, vault_id text not null references vaults(id), file_id text not null,
    writer_facet text not null check(writer_facet in ('device','scoped','system','unknown')),
    writer_principal_id text, writer_account_id text, writer_grant_id text,
    executable integer check(executable in (0,1)), settings integer check(settings in (0,1)),
    source_version_ids text not null, source_namespaces text, recorded_at text not null,
    unique(vault_id,file_id,version_id),
    check((writer_facet = 'scoped' and writer_principal_id is not null and writer_grant_id is not null) or
      (writer_facet = 'device' and writer_principal_id is not null and writer_account_id is not null and writer_grant_id is null) or
      (writer_facet in ('unknown','system') and writer_grant_id is null)))`,
  `create index version_security_file on version_security_sources(vault_id,file_id)`,
] as const

export async function down(_db: Kysely<unknown>): Promise<void> {
  throw new Error('destructive scoped authority downgrade is refused; use reviewed export/import')
}
