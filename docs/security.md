# Security model

Abele Sync trusts the server operator, operating system, database and master-key
storage. It is not designed to hide vault contents from that operator. HTTPS
protects credentials/content in transit; encrypted blob storage protects stored
bytes when the master key is kept separate from a stolen disk. This is not
end-to-end encryption.

## Stored content and secrets

Blobs are addressed by the SHA-256 of plaintext. The stored envelope uses
AES-256-GCM, a per-blob derived key, random nonce and authentication tag. Hash and
tag checks bind bytes to the advertised content identity. Pending upload parts
are also sealed before storage. Database metadata such as names, paths and
history is not made confidential merely because blobs are encrypted.

Keep `ABELE_MASTER_KEY` and `ABELE_TOKEN_PEPPER` independent and high entropy.
Losing/changing the master key makes existing bytes unreadable. Changing the
pepper invalidates hashed credentials. Backups require the original keys, SQL
state and matching blobs; protect all of them and test recovery. Do not log
bearer tokens, passwords or credential-bearing database URLs.

## Authentication and authority

Account sessions, personal devices, scoped machine keys and member installations
are distinct principals. Parsing a token/identity is not authentication, proof
of liveness or authorization. Every request checks the actual endpoint, vault,
principal and authority binding; scoped credentials never acquire a personal
fallback. Reader/editor ceilings are intersected with grant and membership/key
roles, lifecycle, expiry and revocation.

Personal device tokens authorize their vault, even when a client selectively
syncs only a few folders. Do not give a personal token to a restricted worker.
Sensitive grant/publication mutations require fresh owner authority and exact
preview/source identities. Password-confirmed retention/quota changes update
under the vault lock; an unrelated patch does not bypass confirmation for a
protected setting.

Token revocation stops HTTP access and closes personal event sockets. A daemon
persists terminal credential status and stops retrying that credential. Revoking
a device does not automatically revoke sibling devices it enrolled; inspect the
recorded enrolment provenance and revoke siblings separately when appropriate.

## Scoped visibility

Scoped sharing is off by default. Before enabling it, verify compatible clients,
register every actual alternate configuration root, prepare grants/group views,
and establish owner-key recovery and revocation procedures. Do not equate a
successful SQL migration with a prepared authorized scope.

Authorization is based on stable IDs and admitted visibility intervals, not
body references, display names, guessed hashes or cached path equality. Current
reads, history, trash, snapshots, feeds and merge inputs recheck security and
admission. Re-entry does not authorize private-gap versions. Missing or ambiguous
source facts hold delivery rather than permit a broad read or silently rebind.

Executable content, `.obsidian`, registered alternate configuration roots and
sync-owned state are excluded from scoped sharing. Restrictions follow inherited
source lineage through copies, moves and merges; renaming a restricted source
does not make it safe. Registering another configuration root can change existing
eligibility and requires invalidation/reconciliation of affected views.

A shared attachment/extra needs an independently admitted live sponsor. The same
SHA in another principal's vault is not proof of this principal's bytes or
publication authority. Multipart quota discounts require valid owner-bound
content proof; upload and commit outcomes remain partitioned by principal.
Expired snapshots, cursors or preparation leases do not renew themselves.

## Client filesystem and code trust

Clients validate canonical vault-relative paths and content hashes before writes.
The CLI does not follow symlinked subfolders and refuses unsafe placement.
Unexpected mass deletions are held for an explicit version/fingerprint-bound
choice. A held change or staged plugin code must not overwrite later local edits
just because a server response eventually arrives.

Incoming plugin code is staged for explicit approval of the displayed versions;
ordinary settings and plugin data have their separate policies. Scoped agent mode
refuses arbitrary script publication and cannot use a personal token. Existing
local script trust remains necessary: receiving a note or membership does not
make downloaded code trusted.

One process owns a local vault through its exclusive lock and state ledger.
Never sync `.abele-sync` between machines or remove a stale mutation guard while
another process might be using it. SQLite/client ledgers are not safe shared
state over another file-sync service. Use dedicated roots and service users with
restricted permissions.

## Network and operational boundaries

Bind upstream HTTP to loopback/private proxy networks and use HTTPS for remote
clients. Trust forwarded addresses only from a proxy you control, and overwrite
client-provided headers there. Otherwise callers can spoof rate-limit identity.
Rate limiters/event delivery are process-local; multiple server replicas are not
a supported deployment model.

`GET /healthz` is liveness only, not an authorization, SQL, content-integrity or
convergence test. Monitor storage and validate authenticated sync separately.
Neither retention nor encryption is a backup, and a successful restore must
include client cursor/reconnection checks. See [deployment](deploy.md) and
[storage/upgrades](schema.md) for the concrete operator procedures.
