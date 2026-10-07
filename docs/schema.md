# Storage schema and upgrades

Both SQLite and PostgreSQL are supported. The SQL database holds authority,
file/version metadata, history, feed progress and durable retry records. Encrypted
content and unfinished upload parts live in the configured blob directory.
Neither store alone is a complete backup. See [deployment](deploy.md#backups-and-restore)
for coordinated backup/restore commands.

The typed table definitions are in
[`schema.ts`](../packages/server/src/db/schema.ts),
[`schemaAuthority.ts`](../packages/server/src/db/schemaAuthority.ts) and
[`schemaViews.ts`](../packages/server/src/db/schemaViews.ts). The compiled
[migration registry](../packages/server/src/db/migrate.ts) is authoritative;
startup does not discover migration files dynamically.

## Migration chain

An installed migration journal must be an exact prefix of:

1. `001_init`: accounts, personal vault/device/file/version and supporting state.
2. `002_versions_vault_sha`: version/blob lookup indexing.
3. `003_wide_numbers`: safe wide counters and sizes across database dialects.
4. `004_devices_enrolled_by`: sibling enrolment provenance.
5. `005_blob_uploads`: resumable upload state.
6. `006_upload_owners`: explicit upload ownership.
7. `007_version_retention_class`: immutable per-version retention classification.
8. `008_scoped_authority`: grant/principal authority and source security facts.
9. `009_scoped_views`: admissions, grant-local feeds, snapshots and group/publication state.
10. `010_version_path_keys`: normalized historical path keys and bounded lookup indexes.

Unknown names, holes and incompatible ordering are refused before migration
bookkeeping changes. A matching name alone is not proof that an old deployment
installed the matching DDL. Startup also checks required scoped columns/tables,
historical-path indexes and incompatible cached group facts. Do not edit a
journal, remove facts or manufacture schema columns to bypass a refusal.

## Personal data and content

Files have stable IDs and unique normalized paths within a vault. Versions refer
to content-addressed blobs and preserve historical paths and provenance. A
version's `retention_class` is independent of its current filename; renaming a
note into another category cannot shorten the retention of an older version.
Unknown classification is retained conservatively rather than guessed.

Uploads and multipart uploads carry their actual device/principal owner. Two
principals can independently hold pending entitlements for the same SHA; one
principal's revocation must not discard another's bytes. Temporary uploaded bytes
count against quota while waiting to be committed. Durable operation outcomes
and response payload retention are distinct so retry identity can outlive a
large response.

## Scoped authority

Grants bind the actual vault owner, folder prefix or group root identity, role
ceiling, lifecycle and authority/scope/publication revisions. Memberships, keys
and installations carry separate grant/account/vault identities and lifecycle.
Scoped membership does not create unrestricted personal vault membership.
Invitation/enrolment/key-issuance recovery records use hashes and protected token
slots, not plaintext bearer tokens.

`version_security_sources` preserves authenticated source lineage, executable/
configuration restrictions and source namespaces. Facts may be unknown; absence
never creates a negative security fact. Compact lineage does not require a
foreign key that keeps every historical payload alive forever.

## Scoped views

Admissions bind grant, file, generation and visibility interval. Current heads,
scoped trash and version admissions are distinct from personal current-file
state. Grant-local feed state/events do not reuse a personal vault-global cursor.
Snapshots materialize exact heads and bind principal and authority/publication
revisions rather than reading whatever head happens to exist on a later page.

Snapshot/group-preparation pins name exact versions with finite leases. Their
maximum lifetime is five minutes from the server-issued timestamp. Retention
honors live pins under the vault lock and releases expired/invalidated pins;
compact admissions, origins and outcomes can survive payload collection.

Group anchors, introducer origins, stable bindings/tombstones, bounded source
parse facts and dirty work record identities, not arbitrary body links. Missing
or ambiguous evidence cannot silently rebind a group. Sponsored extras bind
independent admitted sponsors and generations; dormant/revoked sponsors cannot
resurrect an old publication interval.

Schema constraints protect tuple identity, enum/lifecycle shape, nonnegative
revisions and finite expiry. Runtime authorization, aggregate budgets, role and
sponsor liveness, fresh-password checks and safe projection remain necessary.
Installing the tables does not enable scoped sharing.

## Upgrade procedure

Stop all old server, collector and admin writers before an upgrade; also stop
daemons during an incompatible client transition. Preserve and test a matching
database/blob/key recovery set and pin the old image. Do not use a rolling mix
of old/new writers against a changed schema.

The read-only preflight command inspects an existing target after building:

```sh
ABELE_DATABASE_URL='<target database URL>' npm run upgrade:preflight -- upgrade.json
```

`upgrade.json` contains operator attestations, not backups made by the tool:

```json
{
  "database": "deployment/database identity",
  "sourceRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "writersStopped": true,
  "collectorsStopped": true,
  "databaseBackup": "verified database backup identifier/location",
  "blobBackup": "verified matching blob backup identifier/location"
}
```

Replace the example revision with the exact deployed commit. Missing fields,
false stop assertions, a branch name instead of a commit, an unreachable target
or incompatible ancestry/schema fail. Success prints the actual journal, target
chain and attestation for comparison; it does not authorize an upgrade, stop
writers, verify a backup or apply migrations. SQLite inspection requires an
existing file, opens read-only and does not change journal mode. Keep connection
secrets and backup contents out of the attestation and source control.

The server applies migrations before listening. SQLite uses transactional DDL
including the migration journal; PostgreSQL uses its transactional migrator.
A failed migration must preserve the prior committed schema/journal, but still
requires log inspection before retry. Scope preparation/recovery is separate
from SQL migration success.

There is no supported destructive downgrade. Incompatible earlier schemas or
legacy group evidence require a planned export/import or a new compatible
migration; disposable installations can be recreated. Rollback restores the
matching old database, blobs and keys, then runs the old image. Restoring a
snapshot may disagree with clients' cursors, so validate authenticated history,
downloads and reconnect behavior before admitting real clients.
