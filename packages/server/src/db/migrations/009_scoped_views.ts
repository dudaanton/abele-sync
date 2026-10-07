import { PostgresAdapter, type Kysely } from 'kysely'
import { principalColumns, principalConstraints, scopedSql } from './scopedSql.js'

/** Dormant views/evidence. No whole-vault certification, references or staged transactions. */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Fixed DDL cap, independent of caller-supplied expiry or future runtime policy.
  const boundedLease =
    db.getExecutor().adapter instanceof PostgresAdapter
      ? "expires_at::timestamptz <= created_at::timestamptz + interval '5 minutes'"
      : "julianday(expires_at) is not null and julianday(created_at) is not null and julianday(expires_at) <= julianday(created_at, '+5 minutes')"
  await scopedSql(
    db,
    viewStatements.map((statement) => statement.replaceAll('bounded_lease', boundedLease))
  )
}
export const viewStatements = [
  `create table scope_admission_intervals (
    id text primary key, grant_id text not null, vault_id text not null, file_id text not null,
    generation bigint not null check(generation > 0), intrinsic integer not null check(intrinsic in (0,1)),
    baseline_version_id text not null, admitted_at text not null, ended_at text,
    end_reason text check(end_reason in ('deleted','departed','unknown')),
    unique(grant_id,vault_id,file_id,id,generation), unique(grant_id,vault_id,file_id,id,generation,intrinsic),
    foreign key(grant_id,vault_id) references scope_grants(id,vault_id),
    check((ended_at is null and end_reason is null) or (ended_at is not null and end_reason is not null)))`,
  `create unique index scope_interval_live on scope_admission_intervals(grant_id,file_id) where ended_at is null`,
  `create table scope_version_admissions (
    grant_id text not null, vault_id text not null, file_id text not null, interval_id text not null,
    generation bigint not null check(generation > 0), version_id text not null, admitted_at text not null,
    primary key(grant_id,file_id,interval_id,version_id), unique(grant_id,vault_id,file_id,interval_id,version_id),
    foreign key(grant_id,vault_id,file_id,interval_id,generation) references scope_admission_intervals(grant_id,vault_id,file_id,id,generation))`,
  `create index scope_admitted_version on scope_version_admissions(vault_id,version_id)`,
  `create table scope_current_members (
    grant_id text not null, vault_id text not null, file_id text not null, interval_id text not null,
    version_id text not null, path text not null, kind text not null check(kind in ('note','canvas','attachment')),
    sha text, size bigint not null check(size >= 0), mtime bigint not null check(mtime >= 0),
    primary key(grant_id,file_id),
    foreign key(grant_id,vault_id,file_id,interval_id,version_id) references scope_version_admissions(grant_id,vault_id,file_id,interval_id,version_id))`,
  `create table scope_trash (
    grant_id text not null, vault_id text not null, file_id text not null, interval_id text not null,
    last_version_id text not null, deleted_version_id text not null, deleted_at text not null,
    expires_at text not null, eligible integer not null default 1 check(eligible in (0,1)),
    primary key(grant_id,file_id,interval_id),
    foreign key(grant_id,vault_id,file_id,interval_id,last_version_id) references scope_version_admissions(grant_id,vault_id,file_id,interval_id,version_id),
    check(expires_at > deleted_at))`,
  `create index scope_trash_expiry on scope_trash(expires_at)`,
  `create table scope_feed_state (
    grant_id text primary key references scope_grants(id), generation bigint not null default 0 check(generation >= 0),
    position bigint not null default 0 check(position >= 0), minimum_position bigint not null default 0
      check(minimum_position >= 0 and minimum_position <= position), updated_at text not null)`,
  `insert into scope_feed_state(grant_id,updated_at) select id,created_at from scope_grants`,
  `create table scope_feed (
    grant_id text not null references scope_grants(id), generation bigint not null check(generation >= 0),
    position bigint not null check(position > 0), event_type text not null check(event_type in ('content','deleted','departed','policy')),
    file_id text, interval_id text, version_id text, safe_payload text not null, at text not null,
    primary key(grant_id,generation,position),
    check((event_type = 'content' and file_id is not null and interval_id is not null and version_id is not null) or
      (event_type in ('deleted','departed') and file_id is not null and version_id is null) or
      (event_type = 'policy' and file_id is null and interval_id is null and version_id is null)))`,
  `create index scope_feed_time on scope_feed(at)`,
  `create table scope_snapshots (
    id text primary key, grant_id text not null, vault_id text not null, ${principalColumns},
    scope_revision bigint not null check(scope_revision >= 0), acl_revision bigint not null check(acl_revision >= 0),
    publication_revision bigint not null check(publication_revision >= 0),
    feed_generation bigint not null check(feed_generation >= 0), feed_position bigint not null check(feed_position >= 0),
    row_count bigint not null check(row_count between 0 and 100000),
    state text not null default 'paging' check(state in ('paging','complete','invalidated')),
    created_at text not null, expires_at text not null, unique(id,grant_id,vault_id), ${principalConstraints},
    check(expires_at > created_at and bounded_lease))`,
  `create index scope_snapshot_principal on scope_snapshots(grant_id,principal_kind,principal_id,state)`,
  `create index scope_snapshot_expiry on scope_snapshots(expires_at)`,
  `create table scope_snapshot_items (
    snapshot_id text not null, grant_id text not null, vault_id text not null,
    ordinal bigint not null check(ordinal between 0 and 99999), file_id text not null, interval_id text not null,
    version_id text not null, path text not null, kind text not null check(kind in ('note','canvas','attachment')),
    sha text not null, size bigint not null check(size >= 0), mtime bigint not null check(mtime >= 0),
    primary key(snapshot_id,ordinal), unique(snapshot_id,file_id), unique(snapshot_id,grant_id,vault_id,file_id,version_id,sha),
    foreign key(snapshot_id,grant_id,vault_id) references scope_snapshots(id,grant_id,vault_id) on delete cascade,
    foreign key(grant_id,vault_id,file_id,interval_id,version_id) references scope_version_admissions(grant_id,vault_id,file_id,interval_id,version_id))`,
  `create table scope_snapshot_pins (
    snapshot_id text not null, grant_id text not null, vault_id text not null, file_id text not null,
    version_id text not null, sha text not null, primary key(snapshot_id,version_id),
    foreign key(snapshot_id,grant_id,vault_id,file_id,version_id,sha) references scope_snapshot_items(snapshot_id,grant_id,vault_id,file_id,version_id,sha) on delete cascade)`,
  `create index scope_snapshot_version on scope_snapshot_pins(vault_id,version_id)`,
  `create table scope_folder_preparations (
    grant_id text primary key, vault_id text not null, phase text not null check(phase in ('capture','replay','complete','unavailable')),
    start_seq bigint not null check(start_seq >= 0), inventory_cursor text, replay_seq bigint not null check(replay_seq >= 0),
    created_at text not null, updated_at text not null, expires_at text not null,
    foreign key(grant_id,vault_id) references scope_grants(id,vault_id),
    check(expires_at > created_at))`,
  `create table scope_group_anchors (
    grant_id text not null, vault_id text not null, file_id text not null,
    owner_account_id text not null, approved_device_id text not null, approved_at text not null,
    approval_version_id text not null, primary key(grant_id,file_id),
    foreign key(grant_id,vault_id) references scope_grants(id,vault_id),
    foreign key(grant_id,owner_account_id) references scope_grants(id,owner_account_id))`,
  `create table scope_group_origins (
    id text primary key, vault_id text not null references vaults(id), source_file_id text not null,
    token_key text not null, introduced_version_id text not null, introduced_at text not null,
    origin_kind text not null check(origin_kind in ('owner_personal','grant_native','recipient','unknown')),
    writer_facet text not null check(writer_facet in ('device','scoped','unknown')),
    writer_principal_id text, writer_account_id text, origin_grant_id text, target_file_id text,
    unique(id,vault_id,source_file_id),
    check((origin_kind = 'owner_personal' and writer_facet = 'device' and writer_principal_id is not null and writer_account_id is not null and origin_grant_id is null) or
      (origin_kind in ('grant_native','recipient') and writer_facet = 'scoped' and writer_principal_id is not null and origin_grant_id is not null) or
      (origin_kind = 'unknown' and writer_facet = 'unknown')))`,
  `create index scope_origin_source on scope_group_origins(vault_id,source_file_id,token_key)`,
  `create table scope_group_bindings (
    vault_id text not null, source_file_id text not null, token_key text not null, origin_id text not null,
    target_file_id text, state text not null check(state in ('unresolved','bound','tombstoned')),
    approved_rebind_id text, primary key(vault_id,source_file_id,token_key),
    foreign key(origin_id,vault_id,source_file_id) references scope_group_origins(id,vault_id,source_file_id),
    check((state = 'unresolved' and target_file_id is null) or (state in ('bound','tombstoned') and target_file_id is not null)))`,
  `create index scope_binding_reverse on scope_group_bindings(vault_id,target_file_id)`,
  `create table scope_group_parse_facts (
    vault_id text not null references vaults(id), file_id text not null, version_id text not null,
    status text not null check(status in ('valid','invalid','unknown','limited')),
    facts text not null, committed_seq bigint not null check(committed_seq >= 0),
    recorded_at text not null, primary key(vault_id,file_id,version_id))`,
  `create table scope_group_dirty (
    vault_id text not null references vaults(id), committed_seq bigint not null check(committed_seq > 0),
    ordinal integer not null check(ordinal >= 0), file_id text not null, version_id text not null,
    operation text not null, lineage text not null, created_at text not null,
    primary key(vault_id,committed_seq,ordinal))`,
  `create table scope_group_progress (
    vault_id text primary key references vaults(id), processed_seq bigint not null default 0 check(processed_seq >= 0),
    generation bigint not null default 0 check(generation >= 0),
    bootstrap_start_seq bigint check(bootstrap_start_seq >= 0), bootstrap_cursor text,
    status text not null check(status in ('preparing','ready','unavailable')), updated_at text not null)`,
  `create table scope_group_leases (
    id text primary key, vault_id text not null references vaults(id), start_seq bigint not null check(start_seq >= 0),
    created_at text not null, expires_at text not null, unique(id,vault_id), check(expires_at > created_at and bounded_lease))`,
  `create index scope_group_lease_expiry on scope_group_leases(expires_at)`,
  `create table scope_group_pins (
    lease_id text not null, vault_id text not null, file_id text not null, version_id text not null,
    primary key(lease_id,version_id), foreign key(lease_id,vault_id) references scope_group_leases(id,vault_id) on delete cascade)`,
  `create index scope_group_pin_version on scope_group_pins(vault_id,version_id)`,
  `create table scope_extra_entries (
    id text primary key, grant_id text not null, vault_id text not null, file_id text not null,
    origin text not null check(origin in ('owner','native')), first_version_id text not null,
    generation bigint not null check(generation > 0), withdrawal_generation bigint not null default 0 check(withdrawal_generation >= 0),
    owner_device_id text, reason text check(reason in ('initial_batch','new_local_file','confirmed_existing_file','native_create')),
    created_at text not null, withdrawn_at text, unique(id,grant_id,vault_id), unique(grant_id,file_id),
    foreign key(grant_id,vault_id) references scope_grants(id,vault_id))`,
  `create table scope_extra_sponsors (
    entry_id text not null, grant_id text not null, vault_id text not null, note_id text not null,
    interval_id text not null, admission_generation bigint not null check(admission_generation > 0),
    intrinsic integer not null check(intrinsic = 1), added_at text not null,
    primary key(entry_id,note_id),
    foreign key(entry_id,grant_id,vault_id) references scope_extra_entries(id,grant_id,vault_id),
    foreign key(grant_id,vault_id,note_id,interval_id,admission_generation,intrinsic) references scope_admission_intervals(grant_id,vault_id,file_id,id,generation,intrinsic))`,
  `create index scope_sponsor_departure on scope_extra_sponsors(grant_id,note_id,interval_id)`,
  `create table scope_publication_outcomes (
    grant_id text not null references scope_grants(id), owner_device_id text not null, intent_id text not null,
    request_hash text not null, publication_revision bigint not null check(publication_revision >= 0),
    withdrawal_generation bigint not null check(withdrawal_generation >= 0), outcome text,
    created_at text not null, payload_expires_at text not null,
    primary key(grant_id,owner_device_id,intent_id), check(payload_expires_at > created_at))`,
  `create index scope_publication_expiry on scope_publication_outcomes(payload_expires_at)`,
  `create table scope_native_files (
    vault_id text not null, file_id text not null, grant_id text not null,
    creator_kind text not null check(creator_kind in ('key','installation')), creator_id text not null,
    created_version_id text not null, kind text not null check(kind in ('note','canvas','attachment')),
    created_at text not null, primary key(vault_id,file_id), foreign key(grant_id,vault_id) references scope_grants(id,vault_id))`,
] as const

export async function down(_db: Kysely<unknown>): Promise<void> {
  throw new Error('destructive scoped views downgrade is refused; use reviewed export/import')
}
