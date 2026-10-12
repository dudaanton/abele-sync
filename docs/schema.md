# Storage schema

The public [schema registry](../packages/server/src/db/migrate.ts) creates a fresh
SQLite or PostgreSQL database: `001_engine`, `002_token_access`, then
`003_sync_access`, then `004_conflict_divergences`. SQLite DDL
and its journal are transactional; PostgreSQL uses transactional DDL and a
schema-local journal. Startup is idempotent. An old account/device/grant database
is refused with a fresh-database/wipe diagnostic; no conversion, upgrade window
or old credential support exists. The unused test stand is to be recreated.

## Access

- `users`: display label, creation time and optional disabled time; no password.
- `spaces`: exactly one per user (unique `user_id`), canonical server address and
  settings. Its ID is the retained engine's space/vault ID.
- `directories`: stable identities, parent identities, paths, version identities,
  mtimes and deletion timestamps; provisioning creates `/`.
- `access_scopes`: immutable folder/group selector and optional inherited scope
  boundary. A unique effective key reuses identical selectors/boundaries.
- `access_tokens`: unique HMAC-SHA256 secret digest, space/scope, direct issuer,
  display label and created/revoked times. No reusable secret is stored.
- `scope_members`: current file/directory item, cached once per effective selector.
- `scope_versions`: recorded visibility at each version, not permission inferred
  from a present-day path or digest.
- `scope_changes`: ordered content/removal/delete events at engine/directory
  sequences, recorded with the commit.
- `scope_snapshots` / `scope_snapshot_items`: scope-bound fixed-cursor pages,
  durable across restart; snapshots expire after one hour.

Issuance follows stable directory ancestry. Group equality and root-to-existing
note issuance are available; nested group membership is a later-stage graph
operation and currently fails closed.

## Retained engine

Files, versions, blobs, uploads, pending blob uploads, idempotency, audit,
usage and sequence tables retain their current storage shape and identities.
`files.vault_id`, `versions.vault_id`, `vault_seq.vault_id`, and upload
`device_id` column spellings are engine storage names; new spaces and token
principals are the new ownership model, not account membership or enrolled
credentials. New provisioning initializes a zero sequence for the space.

Versions retain SHA, actual size, authored mtime, receipt time, merge provenance,
canonical paths and immutable retention class. Wide byte/time/sequence columns
are bigint on PostgreSQL. Live file paths remain unique case-insensitively.

Storage cleanup uses spaces/settings and live token receipts. Live heads,
restore dependencies and merge bases remain retained. Partial content reads use
both current membership and recorded version-time visibility. Authorized history
retention references and the history listing API remain stage-4 work.

`conflict_divergences` retains canonical divergent-branch keys and copy identities
without file/version foreign keys or payload pins. Its source tuple is unique;
create-path locators survive original renames without deriving lineage from names.
Space deletion cascades; ordinary payload GC does not erase retry identity.
Startup and backup validation refuse missing conflict identity schema. Downgrade
is refused. No old-account upgrade or filename-based backfill is supported.

The writer has no legacy admission/security imports or scoped-writer bridge.
Legacy account/vault transport and schemas live only in test fixtures for
independent engine regressions. No production source imports them. See the
acceptance harness for the explicit server/client integration boundary.
