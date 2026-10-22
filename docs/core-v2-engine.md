# Core v2 engine binding

The plugin can bind a token connection to the retained production `SyncEngine`
using `V2EngineClient` from `@abele/sync-core`. Root, folder and group connections use the
same transport, scanner, pull/push pipeline, file journal, staging store and
recovery guards. No v1 request is made by this adapter.

## Construct one engine per connection

```ts
import { AccessClient, V2EngineClient, SyncEngine, selectiveDefaults } from '@abele/sync-core'

const access = AccessClient.fromToken(encodedToken, { fetch: hostFetch })
const connection = await access.connection()
// Surface scope_updating/scope_unavailable as connection state, not an empty scope.
if (connection.status !== 'active') throw new Error(connection.status)

const client = new V2EngineClient(encodedToken, {
  fetch: hostFetch,
  WebSocket: hostWebSocket,
})

// Return true only if another active connection still covers this local identity/path.
// Take the host's normal path-coordinator lock while deciding and applying changes.
client.onRemoval = async (serverFileId, path) => otherConnectionsCoverThisPath(path)

const engine = new SyncEngine({
  client,
  fs: connectionFileSystem,
  state: connectionStateStore,
  selective: selectiveDefaults(),
  stillHeld: () => hostOwnsThisConnection(),
  // Use the host's existing immutable code/settings review gate.
  defer: (path) => hostStagesExecutableOrSettings(path),
  onSync: (report) => updateConnectionReport(report),
  onFail: (error, kind) => updateConnectionError(error, kind),
})

const unsubscribeStatus = engine.onStatus(updateConnectionStatus)
engine.start()
// Or await engine.sync() for an explicit bounded cycle.

// Before replacing the engine or closing its ledger:
await engine.stop()
unsubscribeStatus()
```

`hostFetch`, `hostWebSocket`, filesystem, state store and host callbacks are ports,
not globals imported by core. The adapter accepts the same HTTP options as
`AccessClient` except `baseUrl` and raw `token`: the encoded token supplies those.
Do not hand it a login/device token or translate a token into a legacy grant.

Keep separate durable ledgers, journals and metadata for each local connection
ID. All engines may use the same host filesystem, but the host still owns
cross-connection path serialization. A successful fast connection must never
acknowledge another connection's unsent bytes. The acceptance fixture exercises
separate ledgers on one filesystem per device; it does not replace the plugin's
path coordinator or claim simultaneous live-host verification.

## Filesystem and state ports

File mutation ports follow the [exclusive/checked host contract](#filesystem-host-contract).
A checked host may implement conditional effects without object identity, but
must document the final-check-to-mutation gap and return false from installation
proof ports.

The existing `FileSystem` file methods remain unchanged. Token connections also
need directory ports:

- `listDirectories()` yields `{path, identity, mtime}` for real directories,
  excluding engine-owned folders and symlinks. `identity` is stable across a
  local rename; it is not a server ID or read authority.
- `mkdir(path)` preserves existing content and refuses file/symlink obstacles.
- `moveDirectory(from, to)` preserves local directory identity and contents,
  refusing an occupied target. It is used for remote directory moves where safe.
- `removeDirectory(path)` removes only an empty directory. Never implement this
  as recursive deletion: untracked/local work must produce an obstacle, not loss.

The Node adapter implements these ports. Construct it with
`preserveEmptyDirectories: true`; file removal must not prune explicitly synced
empty folders. The plugin must supply equivalent adapter methods.

`StateStore.getMeta` and `setMeta` are mandatory for token connections. Core owns
`v2-directories` (validated directory identities, pending idempotent operation,
and deferred empty-folder cleanup) and `v2-departures` (scope departures that
must not be republished), `v2-authored-departures` (protecting an author's retained
local note across uncertain group-departure responses), and `v2-local-group-links`
(stable connection-local link bindings across rename/restart). Do not share or
mutate these documents from another connection. The ordinary file journal/checkpoint remains the retained engine's
journal/checkpoint. Missing metadata methods fail explicitly.

Directory commits are journaled before HTTP. An uncertain response is replayed
with the same key and body; explicit stale-base replies allow a feed refresh.
Remote directory effects and scope departures can occur while decoding scoped
pages, so the adapter declares `readEffects`. Engine stop drains these calls
before the host may close the ledger. Filesystem/state effects still use the
host's ownership/recovery guards.

## Scope, removals and deletion

`prepare()` is called by the engine, not by the plugin. It validates current token
authority and installs the guarded filesystem/state ports. A renamed folder
selector uses the server's current path, not the encoded display hint.

Folder scanning is limited to that selector. `.obsidian` is excluded through a
partial folder connection. Scope departures are not represented as file deletes:

- If another connection covers the file, `onRemoval` returns true and local bytes
  remain. The departed connection forgets its baseline and suppresses re-upload.
- Without another covering connection, unchanged shared bytes are removed locally.
  Locally edited bytes are preserved rather than silently lost.
- Content returning to scope clears the departure mark and is pulled normally.
- A real delete goes through the retained puller and reaches other root/covering
  connections as an ordinary local deletion.
- Revocation/unavailable scope fails connection validation and never deletes local
  files merely because authority ended.

Group scanning uses only bounded `groups` frontmatter, including reverse-reachable
nested groups and cycles. Unrelated, ambiguous, unresolved and foreign links do
not grant eligibility or change the note bytes. Stable server group IDs and
persisted local bindings follow root renames. Removing a group is a scope
departure, not a global deletion; deleting the root stops the connection.

Attachments are tracked-only through groups until explicit publication. A body
link, Canvas edit, background index or file received through another connection
never publishes a private file. After its durable connection/file-bound consent
is accepted, the host may call:

```ts
await client.publishGroupAsset(path, actualBytes, originalMtime, durableIdempotencyKey)
```

The method uploads actual bytes through this token, then calls `/v2/group-assets`.
Retry with the same key/body after uncertainty. Do not invoke it from background
indexing, and never supply an external-file placeholder as `actualBytes`. A known
private server path/SHA/file ID alone grants no publication authority.

Content downloads name an authorized file and version. There is no digest-only
read endpoint. Uploads establish the current token's entitlement; another token's
pending upload is not consumed. The existing hash checker validates downloaded
bytes before placement. Multipart uploads use the v2 upload endpoints and retain
the server's part/retry contract.

## Management and engine calls

Use `AccessClient` for `connection()`, `issue({scope, label})`, `tokens()` and
`revoke(tokenId)`. `V2EngineClient` is the file engine transport, not a second
connection registry. Token paste/QR uses exactly the same encoded token.

Keep existing `SyncEngine` calls: `sync`, `rescan`, `start`, `stop`, `pause`,
`resume`, `onStatus`, `heldDeletes`, `decideDeletes`, `deferred`, `applyDeferred`
and `keepLocal`. Their existing review/version and recovery requirements apply.

## History and external verification

`versions`, `trash`, `restore`, `restoreDeleted`, and `restoreDeletedMany` use v2
routes only. History is filtered by version-time visibility **before pagination**,
with current authority rechecked. Explicit visible historical bytes can be read
while a file is in trash; the delete head itself has no content. Departures,
earlier-private versions, revoked tokens and unavailable selectors cannot grant
history/restore access. Bulk restore chooses live trash entries under the write
lock and replays deterministically with its original idempotency identity.

`externalFilesCapabilities`, `head`, and `verifyExternalFile` use the token v2
extension. Verification requires the exact live file/version/path/SHA/size,
authenticated decrypted bytes and real plaintext length, a retained blob reference,
and final authority/head checks under the scope write lock. Cached success or a
historical version is not eviction authority. The response is `no-store`. The
host still owns local-generation, pending-forwarding and eviction fences.

## Current host boundaries

- Production core no longer exports `SyncClient`/`VaultClient`, scoped adapters,
  owner-publication hooks or personal-note publication callbacks. Independent
  retained-engine tests use a test-only HTTP client under `tests/legacy/`.
  The CLI connects by encoded token and uses `V2EngineClient`; retained CLI
  fixtures are ported to the real v2 server. No v1 fallback is served.
- Full immutable executable review, including scope departures, overlapping
  connection races, group asset consent and physical Mac/iPhone evidence remain
  unverified. The example uses the existing host review gate; it is not proof
  that every incoming executable operation is covered.

## Verified synthetic evidence

`packages/core/tests/acceptance/` uses real HTTP, durable SQLite, two independent
servers, three devices and separate filesystems with production engines:

- `engineV2.test.ts`: create/edit forwarding, device restart, identical bytes,
  then extra idle cycles with unchanged versions, pending uploads and divergences.
- `directoriesV2.test.ts`: empty folders, stable local rename identities,
  descendant file moves, deletion and further idle cycles.
- `removalV2.test.ts`: partial-folder placement/departure/re-entry, inaccessible
  private destination, revocation preserving bytes, lost file/directory commit
  responses and server/device restart with journal replay.
- `stopV2.test.ts`: delayed scoped page effects drain before ledger shutdown.
- `groupsV2.test.ts`: nested local-note eligibility, foreign frontmatter retention,
  two-server/three-device forwarding, root rename/restart, departure/re-entry,
  idle quiescence and unavailable-root byte preservation.
- `serverGroups.ts` and `serverExternal.ts`: numbered group/publication and
  external-verification server facets. Server integration additionally tests
  private history, trash restore, indexed paging, inherited boundaries,
  corrupt/missing bytes, size ceilings and concurrent authority changes.

These are automated core/server observations, not live Obsidian or phone evidence.

## Filesystem host contract

# Filesystem host contract

Core supports two implementations of `FileSystem.conditionalFile`. The host
chooses the implementation behind the existing port; no additional core API or
runtime capability flag is required.

1. **Exclusive or checked conditional effects.** Exclusive hosts compare the
   displaced regular file at the mutation boundary and publish into an exclusive
   destination. Checked hosts compare fresh SHA-256 and size against the expected
   base, record size and mtime, drain pending host saves, and stat again immediately
   before mutation. Changed stamps, content mismatches, non-file occupants and
   occupied create/move destinations return `false`, a retryable local-change
   refusal. Operational failures throw. Creates require an absence check and the
   host's create-if-absent API; moves refuse occupied destinations. Already-absent
   removals may succeed after the pending-write barrier and a second absence check.
   Checked success is a content/stamp decision, **not atomic exclusion of an edit
   after the last check**. Buffered writes use the host's indexed file API when
   available, with the raw adapter reserved for unindexed replacements.

2. **Durable capture and conservative restoration.** Persist the operation's
   intent before capture. Preserve displaced bytes in durable quarantine before
   destructive publication. On mismatch restore without overwriting another
   occupant, retaining a visible conflict copy if necessary. Persist restoration
   progress so interruption can be recovered idempotently. Retire verified victims
   after successful publication; retire restored quarantine records once the public
   restoration is durable. Retain uncertain evidence. Exclusive hosts fence capture
   against directories and symlinks at the operation boundary and distinguish
   allocation sentinels by identity. Checked hosts inspect path type before capture,
   use no allocation sentinel, and preserve unexpected captured occupants during
   recovery. They cannot claim an atomic type/identity fence after their last stat.
   Missing semantics in either tier fail closed. Lack of object identity alone does
   not disable a host implementing the checked tier.

3. **Installation proof is separate from successful publication.** Only an
   exclusive host with durable object/content proof can return `true` from
   `installedFile` or `AtomicStage.installed`. Checked hosts always return `false`.
   This is supported conservative behavior, not an unsupported write strategy.
   Matching bytes, a persisted intent and a sealed stage do not prove that this
   operation installed the file. Core preserves or reconciles an uncertain pending
   effect without promoting equality into identity, and never blindly replays a
   write over later local edits.

The host must document its tier and the checked tier's final-check-to-mutation
gap. Desktop hosts with native identity support can continue to use the exclusive
tier. Host-side coordination must still serialize the host's own pending writes;
neither tier grants authority to ignore local edits or bypass core review gates.

## Physical-name authority

`FileSystem.pathKey(path)` reports the volume's collision key, including parent
components: exact names, NFC for normalization-only hosts, or protocol `caseKey`
for hosts folding case and Unicode. It must agree with host collision checks and
stay stable for the adapter's lifetime. Inodes and content hashes are not name
keys; independent hard-link names remain distinct.

Preflight, adoption, receipt replay, approval settlement and ledger publication
look up destination ownership through this key. An exact row cannot hide another
identity under an alias. Optional `StateStore.pathCandidates(path)` returns all
rows with equal protocol `caseKey`; core filters by the host key. Transaction
handles must include pending puts/deletes. Memory and SQLite provide indexes;
legacy stores fall back to `all()` and should implement the index for large vaults.

Without a host key, core conservatively folds case and Unicode and holds foreign
aliases rather than evicting them. Node uses this conservative default because
platform alone cannot determine volume rules; a verified volume policy can be
provided through `NodeFileSystemOptions.pathKey`. The plugin must report its host
policy and forward this port through wrappers. No persisted-state migration is
needed. Unknown policies can cause extra holds, but cannot authorize replacement
of a differently spelled foreign file.
