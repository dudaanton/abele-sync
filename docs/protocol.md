# Protocol and sync contracts

The server exposes a JSON HTTP API under `/v1` and an event WebSocket for personal
vaults. The personal wire protocol is version 1; scoped sync uses a separate
version 4 contract. The shared [protocol package](../packages/protocol/src/index.ts)
is the authoritative source of request/response schemas. The
[route implementations](../packages/server/src/api/routes/) define registered
methods, authorization and pagination. This document describes the supported
model rather than every field of every request.

## Credentials and connections

Bearer credentials occupy distinct namespaces:

| Prefix  | Principal           | Authority                                                                                                          |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `abst_` | Account session     | Account operations; fresh password authentication is needed for sensitive owner mutations.                         |
| `absd_` | Enrolled device     | Personal access to its account's vault. Selective sync is a client filter, not a server authorization restriction. |
| `absk_` | Machine key         | A particular grant, vault, owner and reader/editor ceiling, with explicit expiry and revocation.                   |
| `absi_` | Member installation | A particular accepted membership and grant, with its own installation identity and token.                          |

A scoped credential cannot be retried as an account or personal device credential.
A connection binds endpoint, vault, grant and principal identities; changing those
bindings requires a new connection, not reuse of another ledger. Never share a
client state directory or token between machines. See the
[security model](security.md) for authorization and trust boundaries.

## Personal sync

Accounts log in at `/v1/auth/login`, list/create vaults, and enrol devices. The
admin CLI creates the first account; there is no public signup. A device reads
its vault's state, paginated manifest and changes, uploads content-addressed
blobs, then sends create/modify/move/delete operations to the vault commit route.
The event socket is a wake-up signal; the durable change feed is the source of
progress. Revocation closes the device's event sockets as well as refusing HTTP.

Each file has a stable identity, current path and version history. A version
records its bytes, path, timestamp, actor and immutable retention class. Paths
must be canonical, vault-relative and valid on supported filesystems; case and
Unicode-normalized collisions do not create separate server files. Downloads
must hash to the advertised SHA-256 before clients place them on disk.

The server reconciles concurrent note edits against their base version. It keeps
losing originals in history, merges when safe, and creates conflict copies when
an automatic merge would be unsafe. Binary attachments use modification-time
ordering rather than text merge. Quota and file-size bounds apply to results too;
retaining an original in history does not guarantee that an oversized merged
result becomes the current head.

A client journals an in-flight commit before sending it and replays the same
operation identity after an uncertain response. Routes accepting an
`Idempotency-Key` bind that key to the actual request body; reusing it with a
changed body is refused. A successful replay is not permission to reapply local
filesystem writes over edits made after the request.

History and trash are accessible only through authorized vault/file versions.
Knowing a blob hash does not itself confer read authority. Per-vault retention
and quotas are separate from each client's size/selection settings. Changes to
retention spans or quota require the acting account's current password in the
settings request, including increases and removal of limits.

## Scoped sync

`GET /v1/capabilities` advertises whether scoped sync is enabled. It is **off by
default**. Enabling `ABELE_SCOPED_SHARING=on` activates scoped sync, management
and publication together. Scoped sync requests use
`x-abele-scoped-version: 4`; clients reject missing/incompatible capabilities and
never fall back to personal authority.

Folder grants select a canonical prefix. Group grants select a stable root file
identity and certified group membership, not an arbitrary body-text search.
Reader/editor roles are checked against the grant and principal ceilings.
Preparing, expired, revoked or unavailable authority is not a valid active grant.
Owners manage grants and invitations through the grants endpoints; creation and
preparation are separate outcomes. A saved mutation can succeed while its
`preparation` reports failure: retry preparation, not a committed mutation.

Scoped clients use `/v1/scoped/vaults/:v/grants/:g/...` for state, materialized
snapshots, grant-local feed, current content, authorized history/trash, uploads
and commits. They do not consume the personal vault's global cursor. Opaque
cursors bind the principal, grant and authority/publication generation; stale
or mismatched cursors are not reusable after authorization changes.

Admissions identify the intervals in which a file/version is visible. Leaving
and later re-entering a grant does not expose private-gap history. Current reads,
history, trash and merge inputs recheck admission and security facts. Group
membership/bindings are computed from bounded frontmatter facts and stable file
identities. Ambiguous, stale or unavailable facts hold delivery instead of
silently selecting a different target.

Scoped publication can add a sponsored extra only while its independent admitted
sponsor and publication generation remain valid. Native file creation and
publication of an existing file have separate proof requirements. Private byte
identity or a guessed SHA is not proof that the principal uploaded authorized
content. Revocation invalidates relevant authority, feed/snapshot state and
publication; compact outcome records allow safe retry without retaining all
payloads indefinitely.

### Negotiated ceilings

The current capability ceilings are 64 live grants, 32 operations per scoped
request, 8 MiB prepared-note bytes, 1,000 page items, two snapshots and a
300-second snapshot lifetime. These are bounds, not capacity guarantees.
Multipart uploads have additional per-part, aggregate and ownership checks;
clients must obey the advertised limits and wait/retry only retryable errors.

Errors such as `scope_updating`, `scope_unavailable`, `scoped_unavailable` and
`unsupported_scoped_protocol` distinguish unavailable views/contracts from a
valid empty scope. Do not treat them as success, bypass the scoped fence, or
switch to a broader token.

### Group preparation recovery

When every previous group grant is revoked or expired, creating a new group
share (or renewing an expired one) starts a fresh, paged baseline at the current
committed vault head. This also recovers a vault marked `unavailable`. Revoke
**all** unexpired group grants first if replacing a failed preparation; creating
another grant while one remains live does not reset shared evidence. Revocation
retires the old recipients' authority: a replacement grant needs new invitations
or keys.

The new audience stays `preparing` until the baseline and subsequent committed
evidence are certified. Its admission starts at creation/renewal, not at earlier
queued or private-gap versions. Immutable introducer facts and stable bindings
are preserved; missing historical proof is not invented. Abandoned preparation
queues and pins are retired only when there is no remaining live group audience.
This is a new baseline, not a promise to restore lost history or automatically
approve uncertain group relations. A still-live audience's unavailable evidence
requires explicit recovery rather than silently skipping its membership gaps.

## CLI boundaries

Personal mode watches one vault root, applies selective settings and holds large
unexpected deletion sets for explicit confirmation. Incoming plugin code is
staged for version-bound approval instead of automatically installed.

Agent mode is narrower: a fresh dedicated vault root, one editor folder grant
for `Agents/`, exact vault-relative paths and no personal fallback or general
publisher. Its local status command reads a committed ledger snapshot without
locking the running daemon. A revoked/unauthorized credential stops sync with
exit 4 and retains local files and pending work; restarting the same credential
does not clear its saved terminal state. Deployment and recovery commands are
in [the deployment guide](deploy.md#daemon-deployment).
