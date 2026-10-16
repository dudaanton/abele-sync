# Server operator CLI

Run `abele-sync-admin` inside the server container, with the same
`ABELE_DATABASE_URL`, `ABELE_BLOB_DIR`, `ABELE_MASTER_KEY` and
`ABELE_TOKEN_PEPPER` as the server. From a source installation the equivalent is
`node packages/server/dist/admin-cli/index.js`. SQLite and PostgreSQL support
the commands below; the verified local backup is SQLite-only.

## Restoring a backup

1. Stop the server process and retention/GC jobs. Keep clients disconnected until
   the restored server is prepared. Only one server process may own an installation's
   restore checkpoint; this procedure does not support rolling multi-process restores.
2. Restore a matching database and complete blob snapshot into disposable paths
   first and verify the snapshot's blobs. Preserve the original master key and
   token pepper; replacing them does not recover the existing data or credentials.
   SQLite requires a consistent database snapshot, with no stale WAL/SHM beside it.
   PostgreSQL requires a coordinated `pg_dump`/restore and blob snapshot with
   writers and GC stopped; `backup` does not produce PostgreSQL backups.
3. With the server still stopped, install the verified DB and blobs, then run
   `abele-sync-admin restore-generation` using the restored server's environment.
   This command is mandatory after **every** restore, even when the restored cursor
   equals or exceeds a client's cursor, or the whole server disk was restored.
   `--json` returns `{ "generation": "<new UUID>" }`. Run it once more if another
   snapshot is subsequently installed. Do not run it against a live server.
4. Start the server, reconnect upgraded clients, and let their conservative
   reconciliation finish. Check actual bytes and paths on the server and every
   client, including files created after the backup, unsent changes, conflicts and
   outstanding commit journals. Expect no deletes solely because the server forgot
   a file. Keep the old installation and backups until this check succeeds.

The installation stores its last acknowledged heads and generation in
`<ABELE_BLOB_DIR>.restore-head.json`, beside (outside) the blob directory. Keep this
file on durable storage and exclude it from DB/blob restoration. Startup compares
the restored database with this checkpoint and automatically rotates the generation
when it detects rollback, including divergent equal-head histories. Corrupt or
unreadable checkpoints stop startup. An operator may move a damaged checkpoint
aside while stopped and run `restore-generation` to establish a fresh one.

Legitimate operator purges and retention remove purged vaults from the checkpoint
after their database transaction commits. A missing vault alone does not rotate the
installation generation; surviving vaults retain their rollback evidence.

Automatic detection is a backstop: it cannot prove rollback when a vault is wholly
absent, when both the
checkpoint and database were restored together, or history has already advanced
past the recorded head before startup. The mandatory operator bump covers those
cases and restored idempotency receipts. The HTTP acknowledgement checkpoint is
flushed before mutation responses; a crash before acknowledgement remains an
uncertain request, handled by the client's journal and generation reconciliation.

Older clients and servers without the generation extension retain legacy behavior.
Upgrade all clients before relying on restore recovery; do not reconnect an old
client with pending changes during a restore drill. Plugin-specific external-file
and filesystem journals require host integration in addition to the core upgrade.

The CLI calls the current token model's **space** a **vault**. Each owner user
has one vault. Provisioning a new vault creates a new owner user and root
connection; its initial name is the supplied owner label. Renaming the vault
does not rename the user or its connection labels.

## Names and output

Every vault argument accepts an ID or exact, case-sensitive name; every
connection argument accepts an ID or exact label. IDs take precedence over
labels. Duplicate names are allowed, but commands refuse ambiguity and print
every candidate ID. Folder arguments are exact relative paths using forward
slashes; `/` denotes the whole-vault connection scope and cannot be deleted
as a folder.

Output is readable key/value records by default. Add `--json` for one JSON
document on stdout. Errors and interactive confirmation use stderr. Creation
prints the new encoded token once, together with public metadata; list/show
never return secrets or hashes. `user create` retains its bare-token default
output and also accepts `--json`.

## Vaults

```sh
abele-sync-admin vaults list
abele-sync-admin vaults show Work
abele-sync-admin vaults create Work --address https://sync.example
abele-sync-admin vaults rename Work Archive
abele-sync-admin vaults delete Archive
abele-sync-admin vaults delete Archive --now --confirm-purge --yes
```

List includes name, ID, owner ID/label, live file count/bytes, trash bytes,
last recorded change, deletion time and purge eligibility time. Bytes are
logical plaintext bytes, not encrypted disk usage. Last change uses retained
file heads and available audit records; it is null if neither exists.
Show adds live folders in the first two path levels with recursive
file counts/bytes, all connections, and vault-wide `activity_daily` totals
for the last 30 recorded UTC days.

Delete previews the affected vault/counts and connection count, then requires
typing `yes`. Noninteractive invocations require `--yes`; an unconfirmed
invocation makes no changes. The preview is also included in the final JSON
result. Concurrent writers may change counts between preview and the locked
deletion.

Ordinary vault deletion marks the vault deleted and revokes all tokens in
one transaction. Its retained data remains stored and inaccessible to devices.
This schema has no separate trash-period setting: the vault uses the longest
of its notes/attachments/settings retention windows, measured from vault
deletion (365 days with defaults). `purge_after` reports that deadline.
Invoke `gc` regularly (for example through the operator's scheduler); the
server entry point does not schedule retention automatically. GC purges eligible
vault metadata and releases blob references. Ordinary per-file trash behavior
is unchanged.

Permanent deletion requires **both** `--now` and `--confirm-purge`, in addition
to confirmation or `--yes`. It removes file versions, directories, tokens,
scope caches/snapshots, graph records, pending upload metadata and vault
metadata immediately. It then removes unshared referenced blob bytes, in
separate transactions after metadata deletion commits. Shared blobs and blobs
with another pending upload entitlement survive. Unfinished upload-part
directories and orphan/unreferenced uploads are swept by GC. Owner user records, daily activity,
audit entries and hash-only deleted-token refusal proofs survive. The proofs
retain no token label, ID, client address or content and cannot grant access;
they only keep `scope_deleted` distinguishable after purge.
There is no vault undelete command.

## Connections

A connection is a durable token/device credential, not a live network socket.

```sh
abele-sync-admin connections list --vault Work
abele-sync-admin connections show Laptop
abele-sync-admin connections create Work --label Desktop
abele-sync-admin connections create Work --folder Projects/Client --label Contractor
abele-sync-admin connections create Work --group Projects/Index.md --label Reading
abele-sync-admin connections rename Laptop Travel
abele-sync-admin connections revoke Travel
```

Without a scope option, create grants the whole vault (`/`). `--folder`
accepts a live directory path or ID. `--group` accepts a live note path or ID;
it cannot be combined with `--folder`. The operator can provision replacement
credentials even if the original root credential was revoked. Deleted vaults
cannot receive new credentials.

List/show include ID, vault, label, read-only status, current folder/group scope, creation time,
revocation time and active/revoked/scope-deleted/unavailable status.
`last_used` records successful credential use at HTTP authentication or socket
hello, sampled at most once per rolling minute per token across server processes.
Ordinary fresh requests add no timestamp query; a guarded update handles concurrent
stale samples. Timestamp storage errors are logged without failing an otherwise
valid request. Refused credentials and deletion-receipt replays do not advance it.
`address` is the last address sampled with that timestamp. `address_status` is
`unknown` before first use, `client` for a public direct peer or a client address
resolved through the configured trusted forwarding chain, and `proxy` when the
real client cannot be established. Untrusted forwarding headers and private or
loopback peers are not stored as client addresses. Configure
`ABELE_TRUST_PROXY` for the actual trusted proxy networks, and restrict access to
that proxy; forwarding headers alone never establish trust. A proxy that strips
all forwarding evidence cannot be distinguished from a public direct peer.

List/show add `activity_daily` with the last 30 recorded UTC days per token.
Active means the credential's scope is available, not that a device is online.
Ordinary revocation returns `unauthorized`; scope deletion returns
`scope_deleted` (HTTP 401). Socket events distinguish `revoked` (close 4001)
from `scope_deleted` (close 4004). Both leave local files intact.

## Folders

```sh
abele-sync-admin folders delete Work Projects/Client --yes
```

The operator can still choose any folder. The public
[connection deletion endpoint](protocol-v2.md#delete-this-connections-scope-from-the-server)
only deletes the calling connection's own scope. Both publish ordinary file
tombstones and directory deletes through normal sync history. Content is retained in
the vault's ordinary trash, and matching folder/group tokens and inherited
boundaries are revoked. Unrelated paths such as `Projects/ClientExtra`
survive. The action records the local server operator as its actor. Owner
connections receive genuine deletes through their normal feed; clients still
apply their own held-delete safeguards. Revoked connections receive a clear
refusal and cannot silently recreate the subtree. This command does not bypass
or acknowledge client deletion guards.

## Activity

```sh
abele-sync-admin activity --vault Work --since 2026-10-01T00:00:00Z --limit 50
abele-sync-admin log --connection Desktop --limit 20 --json
```

Activity reads audit rows newest first with an inclusive timestamp filter.
`--limit` is 1–10000 (default 100); `--vault` and `--connection` may be
combined. Connection filtering includes that actor's operations and admin
actions naming its token ID. JSON returns `events`, `event_counts` grouped
by action/result **within the returned page**, `daily` per-token transfer/commit
counters, connection use/address samples in `connections`, and `not_recorded`.
Daily rows use the UTC day containing `--since` (whole-day totals) and the same
row limit; audit events retain the exact timestamp filter.

After a vault is purged its old name/connection labels cannot be resolved,
but saved UUIDs still work as activity filters. An unknown UUID returns an
empty event page.

Available events include sync operations, per-operation rejections, and the
new vault/connection/folder administrative actions. Folder-delete details
include the file count and revoked token IDs. Commit auditing is best-effort
and stored after the content transaction; it can be missing after a crash.
Daily counters store `uploaded_files`, `uploaded_bytes`, `downloaded_files`,
`downloaded_bytes` and `commits` for each vault/token/UTC day. Counters begin
when this version is installed; historical transfers and true batch identities
cannot be reconstructed from old per-operation audit entries.

A successful simple upload counts one file and its plaintext body size, including
repeated successful uploads of identical bytes. Multipart uploads count once on
successful completion, not per part. Each completed 200/206 content response
counts one download (including each range request) and its returned plaintext
bytes. HEAD, metadata reads, external verification, failed transfers and aborted
responses are excluded. Counts describe completed transfers, not unique file IDs
or total network traffic. Transfer accounting happens after the successful
response; bookkeeping failures are logged, so a crash or storage error can
underreport transfers without turning a successful sync into a failure.

Commits count new accepted token-engine transactions (including restore,
self-scope deletion and batches with per-operation rejections), not idempotency
replays. Their increments share the content transaction and roll back on failure.
Atomic daily upserts avoid lost increments from concurrent requests. Vault totals
sum all its token rows; daily counters and audit remain available by saved IDs
after vault metadata purge. Only the token's last address is retained, and that
address is removed with token metadata.

Individual transfer timestamps, live socket presence and rejected requests that
never reach the commit engine are not persisted in the audit feed. The command
states these gaps. Earlier administrative actions cannot be reconstructed.

## Existing storage/provisioning commands

```sh
abele-sync-admin user create --label Owner --address https://sync.example
abele-sync-admin gc --json
abele-sync-admin backup --to /backups/new-snapshot --json
```

User creation is the original provisioning spelling. GC runs retained storage,
upload and receipt cleanup. Backup refuses existing destination files and
verifies all snapshot version payloads; PostgreSQL requires an externally
coordinated database/blob snapshot with writers and collectors stopped.

## Output examples

IDs, timestamps and tokens below are abbreviated; output excerpts omit
unchanged fields. Human output uses `key: value | key: value`; JSON contains
the equivalent objects/arrays without truncation.

| Command                                                                      | Example output excerpt                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vaults list`                                                                | `id: v1                                                                                                                                                                                                                                                                | name: Work       | owner: {"id":"u1","label":"Owner"} | file_count: 12                                              | bytes: 840      | trash_bytes: 20 | last_change: 2026-10-16T00:00:00.000Z` |
| `vaults show Work --json`                                                    | `{"id":"v1","name":"Work","folders":[{"path":"Projects","file_count":12,"bytes":840}],"connections":[{"id":"c1","label":"Desktop"}]}`                                                                                                                                  |
| `vaults create Work --address https://sync.example --json`                   | `{"token":"<new encoded root token>","info":{"id":"c1","label":"Work","scope":{"kind":"folder","id":"d1","path":"/"}}}`                                                                                                                                                |
| `vaults rename Work Archive`                                                 | `id: v1                                                                                                                                                                                                                                                                | name: Archive`   |
| `vaults delete Archive --yes --json`                                         | `{"id":"v1","status":"deleted","blobs_removed":0,"preview":{"name":"Archive","file_count":12,"connections":2}}`                                                                                                                                                        |
| `vaults delete Archive --now --confirm-purge --yes --json`                   | `{"id":"v1","status":"purged","blobs_removed":8,"preview":{"name":"Archive","connections":2}}`                                                                                                                                                                         |
| `connections list --vault Work --json`                                       | `[{"id":"c1","label":"Desktop","scope":{"kind":"folder","id":"d1","path":"/"},"last_used":null,"address":null,"status":"active"}]`                                                                                                                                     |
| `connections show Contractor`                                                | `id: c2                                                                                                                                                                                                                                                                | vault_id: v1     | label: Contractor                  | scope: {"kind":"folder","id":"d2","path":"Projects/Client"} | status: active` |
| `connections create Work --label Desktop --json`                             | `{"token":"<new encoded token>","info":{"id":"c1","label":"Desktop","scope":{"kind":"folder","id":"d1","path":"/"}}}`                                                                                                                                                  |
| `connections create Work --folder Projects/Client --label Contractor --json` | `{"token":"<new encoded token>","info":{"id":"c2","label":"Contractor","scope":{"kind":"folder","id":"d2","path":"Projects/Client"}}}`                                                                                                                                 |
| `connections create Work --group Projects/Index.md --label Reading --json`   | `{"token":"<new encoded token>","info":{"id":"c3","label":"Reading","scope":{"kind":"group","id":"f1","path":"Projects/Index.md"}}}`                                                                                                                                   |
| `connections rename Desktop Travel`                                          | `id: c1                                                                                                                                                                                                                                                                | status: renamed` |
| `connections revoke Travel`                                                  | `id: c1                                                                                                                                                                                                                                                                | status: revoked` |
| `folders delete Work Projects/Client --yes --json`                           | `{"cursor":42,"files":3,"revoked_tokens":["c2"],"preview":{"vault":"v1","path":"Projects/Client","file_count":3}}`                                                                                                                                                     |
| `activity --vault Work --limit 1 --json`                                     | `{"events":[{"action":"folder.delete","result":"applied","details":{"files":3,"revoked_tokens":["c2"]}}],"event_counts":{"folder.delete:applied":1},"not_recorded":["daily transfer counters record successful responses, not individual transfer event timestamps"]}` |
| `user create --label Owner --address https://sync.example`                   | `<new encoded root token>`                                                                                                                                                                                                                                             |
| `gc --json`                                                                  | `{"versions_removed":4,"blobs_removed":2,"unreferenced_removed":0,"uploads_swept":0,"idempotency_swept":0}`                                                                                                                                                            |
| `backup --to /backups/new-snapshot --json`                                   | `{"database":"/backups/new-snapshot/abele.db","blobs":"/backups/new-snapshot/blobs","verified":true}`                                                                                                                                                                  |

An ambiguous name fails with a diagnostic such as
`ambiguous Laptop; candidates: c1 (Laptop), c2 (Laptop)` and exit code 1.
