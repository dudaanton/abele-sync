# Unified sync protocol v2

The exported `V2*Schema` objects and inferred types in `packages/protocol/src/v2.ts`
are the shared wire contract. The token payload version is **1**; the API version
is **2**. Legacy v1 exports remain dependencies of retained engine adapters/tests until their replacement;
they are not a second v2 access mechanism.

## Restore generation

Every HTTP response carries `abele-restore-generation`, an opaque UUID identifying
the current server storage generation. The server retains it in the database;
the operator must rotate it after restoring any database/blob snapshot. Startup
also rotates it when the installation checkpoint shows a higher previous head,
an equal head with a different version identity, or a different generation.

Clients read the header during the connection handshake **before journal replay,
directory effects or uploads**, persist it beside their ledger, and echo it on
subsequent requests. A mismatch is rejected with HTTP 409 `conflict` before route
execution, including before idempotency receipt lookup. The client rejects a
response with a changed header before decoding or applying it, then reconciles
on its next cycle. Cursor equality is never proof of the same generation.

On a changed generation, the production core atomically archives the old entries,
cursor, journal, pull-write intents and scope/deletion/directory/deferred metadata, retires pending
replay, and starts a manifest reconciliation without deleting local files. Local
absence does not become a server delete. Identical files are adopted, divergent
bytes are preserved by the existing conflict path, missing server files are
published again, and server-only files are received. A saved join preference is
not applied during this recovery. Previously shared group attachments use explicit
group publication again; discovering a private attachment gives no such authority.
The archive remains in device metadata under `retired-generation:<old UUID>`.
Pull-write intents lose installation authority in the same transaction as their ledger
bases. Staged and installed disk bytes remain untouched for reconciliation. Hosts should
provide `StateStore.metadataKeys` so untracked pull intents are archived as well.

This is an additive header extension: response JSON remains unchanged. A missing
header preserves legacy behavior. Old clients do not echo it and continue their
existing behavior on a new server; they **cannot detect restores**. Upgrade every
client before a restore drill. A proxy must preserve this header in both directions
(and expose it if a browser transport uses cross-origin CORS).

Plugin hosts must vendor the updated protocol/core, preserve durable transactional
metadata, surface the recovery log/error, and fence their own pending publication,
external/offloaded-file and filesystem recovery effects behind the generation
handshake. Host effects outside the core cycle are not automatically reconciled by
the core's file ledger reset. Qualify those effects and overlapping connections on
desktop and phone before claiming plugin coverage.

## Connection token

UTF-8 JSON encoded with standard padded base64. QR carries exactly that string:

```json
{
  "v": 1,
  "address": "https://sync.example",
  "key": "<43-character base64url secret>",
  "scope": { "kind": "folder", "id": "<stable directory ID>", "path": "/" }
}
```

The key is 32 cryptographically random bytes, base64url without padding. The
server stores only a keyed hash. Base64 is not encryption: treat the complete
token as a secret. `encodeAccessToken` / `decodeAccessToken` work in browser and
Node hosts. HTTPS is required except on literal loopback. No login, password,
role, or separate device registration is involved. Group selectors use
`kind: "group"` and a stable group-note ID. Path is only a display hint.
The server resolves the bearer key, not client-edited space/scope hints.

## Stage 1 endpoints

Every route requires `Authorization: Bearer <key>`. Ordinary routes authenticate a live token before doing work; the self-deletion endpoint below additionally permits replay of its own recorded result after revocation.

| Route                   | Request                                         | Response                                                                         |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /v2/connection`    | none                                            | `V2Connection`: protocol, token_id, space_id, current scope/path, status, limits |
| `POST /v2/tokens`       | `V2IssueTokenRequest`: scope `{kind,id}`, label | 201 `V2IssueTokenResponse`: encoded token and public info                        |
| `GET /v2/tokens`        | none                                            | `V2TokensResponse`: items this token can revoke, no keys/hashes                  |
| `DELETE /v2/tokens/:id` | none                                            | `V2RevokeTokenResponse`: `{revoked:true}`                                        |

The local CLI `abele-sync-admin user create --label <label> --address <url>`
atomically creates one user, one space, its stable `/` directory, and its root
token. It prints the encoded token (also the QR payload). There is no HTTP user
creation route. The address is supplied by the operator, never derived from an
untrusted request Host header. Child tokens inherit the canonical server address.

Tokens read and write by default. Issue `read_only: true` to grant reading without content mutation.
Clients send `abele-client-capabilities: read-only` to receive `read_only` in connection
and token-info responses. Issuance requests explicitly containing `read_only` also opt in
for that issuance response. Otherwise the field is omitted, including for read-only
tokens, to preserve older strict response schemas. Server-side permission checks always
apply. Updated core clients advertise this capability automatically.
Delegated tokens inherit read-only access even if a caller requests `read_only: false`. Read-only tokens cannot commit, restore, upload, publish group assets or delete their scope. They can issue equally restricted tokens and revoke tokens under the existing management rules. Issue only the same or a narrower stable
selector. A partial token cannot issue `/` or an unrelated selector. Reuse
identical selectors/effective boundaries; retain inherited boundaries so moving
a child outside an ancestor cannot expand its access. The direct issuer or any
active root-directory token in the same space can revoke. Independently issued
device tokens keep working, including tokens previously issued through the revoked
token. Revocation affects only the selected credential; inherited scope boundaries
remain in force independently of issuer credentials. Missing/invalid credentials,
ordinary revocations and disabled accounts use 401 `unauthorized`. Server-side
scope deletion uses 401 `scope_deleted`, as described below. Forbidden issuance
or revocation receives 403 `forbidden`. Unknown/foreign targets never expose secrets.
An unavailable selector returns connection state, not fabricated removals. A
normal sync directory deletion is different: final delete events remain drainable as
described below.

## Unified folder/root sync API

- `GET /v2/manifest?limit=1000&next=<opaque>`: `V2Manifest`, items and a fixed snapshot
  `cursor`, `next` page or null. A complete empty snapshot is distinct from
  `scope_updating`. Persist the cursor only after the final page.
- `GET /v2/changes?since=<cursor>&next=<opaque>`: `V2Changes`, ordered changes,
  cursor reached, next page or null. Cursors are space-local durable integers;
  never compare cursors between servers.
- `GET /v2/events`: WebSocket authenticated with hello `{token:key}` (or a bearer
  upgrade header for native clients);
  `V2Event` changes notifications trigger feed polling. Connection events carry
  revoked/unavailable/updating state and never instruct file deletion.
- `POST /v2/commit`: `V2CommitRequest`, existing create/modify/move/delete/restore
  file ops plus mkdir/move_directory/delete_directory. `Idempotency-Key` is
  required; authentication precedes replay. `V2CommitResponse` gives ordered
  results and cursor. File results reuse the retained engine's result fields.
- Content entries carry stable file/version IDs, path, kind, SHA, size, mtime.
  Directory entries carry identity/version/path/mtime and no content hash.

### Delete this connection's scope from the server

`POST /v2/connection/delete` implements **Delete from the server** next to a
connection's Disconnect action. It accepts an empty body or
`V2DeleteScopeRequest` (`{}`), with a required `Idempotency-Key` of 1–200
characters. It accepts no folder path, vault ID, token ID or scope selector.
The previous arbitrary-folder `POST /v2/folders/delete` endpoint is removed;
the operator's local `folders delete` command remains available.

```http
POST /v2/connection/delete
Authorization: Bearer <this connection's token key>
Idempotency-Key: <persisted request UUID>
Content-Type: application/json

{}
```

An active write token deletes its own current authorized scope:

- Whole-vault (`/`) token: every live file and non-root directory, including
  configuration files. The stable root and vault metadata remain available for
  recovery; this API does not mark the vault deleted or purge its trash.
- Folder token: live files and directories in that subtree which it could
  already delete individually. Private/excluded files remain untouched; their
  directory ancestors remain intact. Sibling paths are unaffected.
- Group token: current authorized group members, including nested group notes
  and published assets. Shared members are genuinely deleted, so other valid
  covering connections see those same ordinary deletes. Unrelated files remain
  untouched. Empty parent folders outside the group membership are preserved.

The server resolves and preauthorizes the selection under the normal engine's
space lock before changing group selectors. File-delete versions, directory
tombstones, normal scope history, the administrative audit record, revocation
and the idempotency result commit together or roll back together. No device
download, client manifest or base-version preparation is required. Content
goes into ordinary server trash; the existing trash/restore endpoints remain
the recovery mechanism and normal retention policy still applies.

After deleting the content, the server revokes the calling token, tokens scoped
inside the deleted folder/group, tokens rooted at deleted group notes, and
tokens inheriting those boundaries. Whole-vault deletion revokes every token
of that vault, so no existing whole-vault connection remains usable. Revoked
tokens are not restored when files are restored. After a whole-vault deletion,
the operator can issue a new root connection with `connections create` and use
its normal trash/restore endpoints to recover retained content.

Success is 200 `V2DeleteScopeResponse`, for example:

```json
{ "cursor": 42, "files": 3, "revoked_tokens": ["<calling-token-id>", "<nested-token-id>"] }
```

The `connection.delete` audit entry identifies the calling token and records
its label, resolved scope, file count and revoked token IDs. Ordinary file
versions likewise retain the token label as the actor name.

**Retry contract:** persist the idempotency key before sending. A retry with the
same secret and key returns exactly the recorded result, including after the
token revoked itself. The server proves the original secret using its stored
HMAC; a public token ID, a different token's secret, or a new key cannot retrieve
that result. Concurrent same-key requests serialize and return the same receipt.
These specific receipts survive ordinary receipt GC while the token metadata
exists; permanently purging the vault removes both tokens and receipts.
No other route gains an authentication exception, and receipts from other
operations cannot be replayed through this endpoint. Reusing another operation's
key with an active token returns 422 `idempotency_mismatch`.

Read-only tokens receive 403 `forbidden`, without deleting or revoking anything.
Invalid bodies or missing/invalid idempotency headers receive 400
`invalid_request`. Missing, unknown or revoked credentials without a matching
self-deletion receipt receive 401. Ordinary revocation uses `unauthorized`;
a token revoked by server-side scope deletion uses `scope_deleted` with
message "Deleted on the server" on every authenticated route (including unknown
routes and requests missing an idempotency header). The valid same-key deletion
receipt replay remains the explicit exception and returns its original 200 result.
Deletion refusals survive permanent vault purge through hash-only refusal
proofs; they do not retain or reactivate a connection.
Error responses also include `X-Abele-Error-Code`, so HEAD clients can distinguish
the reason without a response body. Unavailable scopes cannot
start a new deletion. A retained matching receipt returns the recorded result
only and grants no new read, restore, write or token-management access.

Deleted-scope sockets emit `{type:"connection",status:"scope_deleted"}` and close
with 4004; ordinary revocations still emit `revoked` and close with 4001.
Subsequent ordinary HTTP requests receive 401 and cannot silently
re-upload. Clients keep their local files on revocation; the plugin stops that
connection. Still-valid covering connections (for example a root connection
after a folder token deletes its scope) see ordinary delete history and apply
their normal held-delete safeguards. This differs from a normal
`delete_directory` sync operation, which leaves still-valid folder tokens able
to drain final delete events as described below.

### Removal is not deletion

`content` contains the current visible item and a visible previous path (or
null). `removal` contains only the previously visible file ID/path, cursor and
time. It means the file left an **otherwise active** scope. It must not disclose
its private destination, and must not be forwarded as a global deletion. The
host retains a local file covered by another connection. A real `delete` has a
version ID and propagates to other covering connections. Revocation/disconnect
and unavailable group roots leave already downloaded local files untouched.

Deleting the selected **folder** is a genuine directory/content deletion, not a
revocation. Before the stream closes with `scope_unavailable`, it announces the
final change cursor. The still-valid folder token may drain **delete events only**
from `/v2/changes`, even while its selector is unavailable. Content, manifest,
upload and commit requests remain denied, and a new folder at that path cannot
revive the old selector. Clients must drain this final feed before treating the
connection as unavailable. Deleted **group** roots do not imply these deletions.

The public app registers no `/v1` compatibility routes and only initializes a fresh token-space database. No account/vault data conversion or upgrade window exists.

Root and folder scopes now use these operational endpoints. Directory IDs survive
owner moves/renames; empty directories are manifest items. Moving a directory
updates its descendants atomically. Deleting a folder selector permits draining
its genuine final deletes, then leaves the connection unavailable; a replacement
at the same path cannot revive that identity.

Snapshots are stored durably for one hour, bound to the effective scope. Their
cursor is fixed across pages, including across restart. Feed pages use an opaque
`next` string (currently the last emitted space-local sequence as a decimal
string); use it unchanged. Members, version-time visibility and content/leave/
delete events are recorded inside the engine transaction, including merge and
conflict outputs. Credential and inherited-boundary checks precede receipt replay.

### Upload and content routes

| Route                                            | Operation                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `PUT /v2/uploads/:sha`                           | Raw `application/octet-stream`, 201 `{sha,size}`; always supply actual bytes, no hash-only shortcut    |
| `POST /v2/uploads/:sha/begin`                    | `{size}`, 201 retained `UploadBeginResponse` with upload ID, part size/count and received part numbers |
| `PUT /v2/uploads/:sha/:id/:part`                 | Raw part bytes, 204; upload is bound to token, space and digest                                        |
| `POST /v2/uploads/:sha/:id/complete`             | 201 `{sha,size}` after verifying all parts and their hash                                              |
| `GET/HEAD /v2/files/:id/content?version_id=<id>` | Current content by default; range/HEAD supported; no arbitrary blob-by-hash reads                      |

A commit may name bytes uploaded by its own token or a version currently readable
through its scope. Knowing another file's digest cannot authorize content or a
commit. Partial content reads require current membership **and** recorded
version-time visibility, so entering a shared folder does not expose earlier
private history. Partial connections exclude `.obsidian` and the configured
configuration roots; ordinary scripts inside shared folders travel as content.

Group sync fails closed with `scope_updating` until stage 3 builds the graph.
History/restore UI, group assets and root settings endpoints remain later-stage
work. The retained merge algorithm still depends on `work/server-merge`; expected
failures cover first-connect divergence, stale line merge and original merge
mtime. No migration or old-client compatibility is provided.
