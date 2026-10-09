# CLI external-file recovery and lifecycle foundation

This implements the CLI/core side of the initial recovery barrier, instance and
ownership fencing, activation migration and conservative lifecycle inventory. It
adds no UI, automatic eviction, attachment filesystem installer, materialization
API or old/target credential-switch workflow. Production external eviction is
still disabled until the later classification and attachment APIs are wired.

## Startup and effects

A mutating personal command takes the existing physical-vault lock, inspects
external/connection-switch evidence and projections without creating a ledger,
then opens its own SQLite connection. Its ledger-instance UUID is committed in
`daemon:ledger-instance-id`; a descriptor may only refer to that actual opened
physical file. Missing/replaced instances cannot inherit activation permission.
The external phase adapter remains attached to this same private connection.

Before activation, the host validates publication and installation journals,
settles tracked predecessor effects, and runs the existing code-group recovery.
A normal personal pull can reconcile an interrupted installation using its exact
recorded version, target and still-current pre-write ledger base. This recovery
only updates bookkeeping; it never writes, moves or deletes a file. Equal bytes
without that recorded intent cannot authorize adoption. Changed bytes retain
their earlier base. A valid personal publication journal is resolved under its
original idempotency key before ordinary scope changes start. Incoming code
results remain staged for explicit approval. Corrupt/foreign evidence is held.

Only then does the CLI enable scope recording, scanner/watchers, sync/rescan,
delete decisions, deferred apply/keep, publication and Restore. Scoped agents use
the same inventory/ownership discipline and their existing tagged scoped journal;
scoped heads and checkpoints remain exclusively in `ScopedState`. Unresolved
scoped installation intents and orphan outbox material are conservative holds.
No scoped credential is retried as a personal credential. Recovery replay also
retains the normal recent-delete tally and confirmation semantics; recovered
unconfirmed deletes count toward the shipped 15-minute mass-delete guard.

Ownership is checked against the actual lock identity, not merely at the next
heartbeat. Runtime effects recheck the connection binding, generation, credential
association, physical database identity and durable instance UUID after awaits.
Checks run at SQLite writes/COMMIT, native filesystem mutation/cleanup, and every
HTTP request, including later multipart requests. Code-approval staging and
recovery use the same discipline. The SQLite external adapter rejects outer
transaction nesting and stops after unknown COMMIT acknowledgement; activation
cannot bypass that hold through a fresh facade over the same connection.

Already-issued requests/syscalls are not claimed cancelled. Cooperating runtimes
in the same process wait for tracked predecessor effects, then inspect durable
journals before activating. Application restart resolves recorded publication/
installation outcomes or holds them. Lost ownership prevents new effects and
leaves ambiguous artifacts for recovery. This is coordination of cooperating
runtimes, not exclusion of independent filesystem writers, and it does not
change the accepted attachment deletion race or the native no-clobber hydration
requirement.

## Config and activation migration

Legitimate pre-activation legacy configurations remain readable. Ordinary writes
retain their legacy shape unless the explicit activation API has migrated them.
No command automatically calls `activateExternalFiles` or
`activateAgentExternalFiles`.

Before later eviction can be enabled, the trusted activation API records a
`preparing` marker in `.abele-sync/external-activation.json`, writes a versioned
config envelope, initializes/validates the bound schema-1 document on the same
ledger, and finally records `active`. A preparing migration can resume only in
that exact physical database/instance and connection. An active missing journal,
changed binding/instance, unknown acknowledgement, or retained
`.abele-sync/external-connection-switch.json` requires recovery, not bootstrap.

The personal `config.json` and scoped `agent.json` envelope is:

```json
{
  "format": "abele.cli",
  "schema": 2,
  "connection": { "...": "the existing connection config" },
  "descriptor": {
    "ledgerId": "owned-ledger-id",
    "instanceId": "database-instance-uuid",
    "binding": { "...": "normalized local connection binding" }
  }
}
```

The required old connection fields are absent at the top level. Adding only
`schema: 2` beside legacy fields is explicitly insufficient: the old reader
ignores unknown fields. A SQLite `user_version` is likewise not a fence against
an old binary that never checks it. Config updates after migration preserve the
envelope and cannot silently rotate/rebind its credential association.

Markers/descriptors contain identity and a credential fingerprint, not bearer
credentials, download URLs or device preferences. The existing connection token
remains only in its private connection config. Config/marker files use the
existing private state-folder permissions.

## Initial lifecycle policy

Disconnect, forced initialization/re-enrollment, scoped agent setup/disconnect
and delayed cleanup check the shared read-only inventory under ownership before
revocation, credential/config replacement or state removal. It includes external
records/operations, projections (including renamed, malformed or oversized root
markers), publication/owner holds, deferred approval, deletion decisions,
installation intents, scoped conflicts/detach, and retained/staging directories.
Known external state protects damaged projection paths through a connection hold.
Projection discovery is one asynchronous pass per startup: it stats candidates
first, respects selective exclusions and `.abele-sync-ignore`, skips files larger
than 16 KiB without opening them, and caps raced reads at 16 KiB. A private
`projection-index.json` caches exact path/size/mtime observations; damaged cache
entries are re-inspected and known positive evidence remains a hold. The pass
yields to timers so the lock heartbeat continues. An unknown oversized renamed
projection cannot be identified from metadata alone under this read budget.

Every nonempty external document and activation/switch marker remains a hold,
including hydrated policy records, terminal operations, tombstones, pending
downloads and unavailable/detached records. `--force` is not an exception. Offline,
space, approval or access blockers preserve the connection and evidence; there is
no automatic materialization in this foundation. A later preparation API must
prove and persist readiness before relaxing these refusals.

An ordinary pre-activation connection with an empty inventory retains its prior
CLI behavior, including local forced forgetting of an unsafe/unreachable address
without sending its token. Normal read-only status and the legacy beside-daemon commands retain a binding/
instance/recovery fence even without owning the daemon's lock. Every later HTTP
request and SQLite decision write rechecks it after awaits. Normal pull intents
carry the preparing lock identity; readonly commands may inspect a live local
daemon's matching intent, but crash/foreign-owner intents remain holds. Empty
scoped staging directories are pruned after publication and are not retained
bytes; files and pending records still block retirement.

## Old direct-deletion boundary

`tests/fixtures/config-v1/config.ts` and `commands/init.ts` pin the actual v0.1.1
sources from `f927e62`. Tests execute that old reader accepting legacy/extra-field
config and rejecting the nested envelope, then separately execute its force-init
path bypassing the config-open refusal and deleting SQLite files. Compatible
neighboring helpers resolve the fixture imports; this is not a claim to execute
every component of the old binary.

**Unsupported:** old force-init/direct filesystem deletion can still remove a
ledger without opening the new schema. New code cannot prevent an old binary or
operator from deleting files. The surviving activation marker makes the new
client refuse bootstrap afterwards. Restore the exact bound ledger/recovery
material; do not treat old direct deletion as a supported reset. Deleting all
markers/config/evidence manually is not covered by a fictitious schema guarantee.

## Plugin adoption of the compatible core change

`EngineOptions.recovery` is optional. Omitted, the existing eager constructor
scope/status behavior is preserved for the current pinned plugin. Its existing
policy of constructing only after recovery remains valid until it adopts this
core revision.

To adopt explicit readiness:

1. Use core's shared state schemas, `ExternalState`, `ExternalStateError` and
   adapter semantics together; do not mix the prototype error class/facade with
   the shared adapter.
2. Create a `RecoveryBarrier` with the plugin's current runtime-ownership guard
   and pass it as `recovery` to every personal `SyncEngine`, including approval/
   temporary engines. With this option construction performs no scope/status
   effects. Call `activate()` only after migration/binding validation, predecessor
   settlement and safe journal recovery/holds.
3. Call start/sync/rescan/recordScope/deferred/delete operations only after that
   readiness. `start()`/`resume()` refuse synchronously while held; promise verbs
   reject. `restore()`/`restoreDeleted()` are also serialized and recovery-gated,
   and stopping waits for already-issued Restore outcomes like other writes.
4. Keep the plugin's native adapter, actual IndexedDB transaction/commit and
   per-request HTTP fences. A core entry-point proxy cannot replace checks inside
   a long adapter save or later multipart request. Retained history/Restore
   clients must remain fenced even if the plugin continues using its direct
   client rather than the new engine Restore methods.
5. Vendor committed aligned core/protocol inputs and update provenance/fixtures
   explicitly. This work did not edit the plugin worktree or its archives.

## Verification

The acceptance tests use real on-disk CLI SQLite close/reopen, definite abort and
lost COMMIT acknowledgement, stale-runtime/long-await native and multipart
checks, startup/mutation/lifecycle holds, preparing migration recovery and the
pinned old-reader/direct-deletion demonstration. Existing real daemon SIGKILL
and all-or-nothing code approval tests remain in place. Application restart is
covered; arbitrary power-loss survival and phone execution are not claimed here.
