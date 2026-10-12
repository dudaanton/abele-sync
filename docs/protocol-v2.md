# Unified sync protocol v2

The exported `V2*Schema` objects and inferred types in `packages/protocol/src/v2.ts`
are the shared wire contract. The token payload version is **1**; the API version
is **2**. Legacy v1 exports remain dependencies of retained engine adapters/tests until their replacement;
they are not a second v2 access mechanism.

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

Every route authenticates `Authorization: Bearer <key>` before doing work.

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

All valid tokens read and write. Issue only the same or a narrower stable
selector. A partial token cannot issue `/` or an unrelated selector. Reuse
identical selectors/effective boundaries; retain inherited boundaries so moving
a child outside an ancestor cannot expand its access. The direct issuer or any
active root-directory token in the same space can revoke. Independently issued
device tokens keep working, including tokens previously issued through the revoked
token. Revocation affects only the selected credential; inherited scope boundaries
remain in force independently of issuer credentials. Disabled
users and revoked keys receive 401 `unauthorized`; a forbidden issuance or
revocation receives 403 `forbidden`. Unknown/foreign targets never expose secrets.
An unavailable selector returns connection state, not fabricated removals. A
real directory deletion is different: final delete events remain drainable as
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
