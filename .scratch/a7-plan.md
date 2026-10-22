# A7: staged migration to one durable inbox

Plan only, revised against `38415de` and the A7 plan review. No implementation or tests are included. Four independently shippable stages replace independent work bookkeeping without changing the approved applied-cursor contract. Scope includes D-110–D-120 and D-136–D-154, incoming departures, outgoing uncertainty, and lifecycle safety. This design uses our own protocol and host contracts.

## 1. Decision and invariants

First centralize settlement behind existing stores; then transfer ownership of incoming work; then outgoing work; finally remove legacy storage after lifecycle readers have been converted. Each family has exactly one active owner, selected by a durable migration epoch. Shadow imports never execute. Compatibility adapters route commands to that owner; they do not dual-write competing authorities.

**Keep the applied cursor:** `min(reached, first unresolved sequence - 1)`, including queued but unapplied work. Centralize its calculation and persist it in the same transaction as the changes to unresolved work. Coverage refers to server page intervals, not an assumption that filtered feeds contain every integer sequence. Inventory completion uses its real snapshot head; an interrupted manifest must not manufacture head zero. No stage silently converts this cursor into a metadata-ingestion acknowledgement. Any future public ingest-cursor API is a separate proposal.

Durably captured pages allow local replay without repeated downloads. Their contiguous captured frontier is derived from page coverage, not an independently mutable cursor or scheduler. A page can be captured beyond the applied cursor; it cannot advance that cursor past unresolved work. Refusal is an unresolved obligation unless an explicit existing policy decision permits passing it and leaves owned rediscovery work. Migration preserves such historical obligations even when their event is already behind the cursor.

Required invariants:

1. Every captured event and local uncertain action has a durable identity and owner. Clearing a checkpoint or firing a timer cannot resolve it.
2. Resolution requires application, proven already-applied state, justified supersession with a reference, or an explicit decision. A changed baseline alone is not supersession.
3. Every settlement checks source identity/version and destination physical-path ownership, including adoption and ledger-only publication. Equal bytes prove neither authority nor installation.
4. Filesystem/network effects run outside short state transactions, with durable preparation and recovery evidence. A crash leaves redoable work; no claim of a transaction spanning server, filesystem and database.
5. Pause fencing, conditional filesystem operations, protected local edits, scopes, groups, delete guards and transfer budgets remain in force.
6. Per-item persistence is O(1) amortised with indexed, bounded scheduling. No whole-queue serialization or startup scan of all entries to find due work.
7. Disconnect, retirement and re-enrollment must see every unresolved dependency, regardless of which migration stage owns it. Evidence is not garbage until its owner and lifecycle dependencies are resolved.

## 2. Current mechanisms and destination

Audit writers **and readers**, including host callbacks and lifecycle commands, before each family switches ownership. The following is the migration inventory, not permission to delete all these mechanisms at once.

| Mechanism today | Responsibility and mapping | Stage |
| --- | --- | --- |
| State cursor; Puller reached/pending sequence/completion barrier | Keep applied semantics. One settlement commit computes the frontier; captured page envelopes prove ingestion completeness. | 1 centralizes, 2 transfers |
| Manifest header/page checkpoints | Owned inventory session with snapshot head, continuation, scope and membership evidence; no second held list. | 2 |
| PullHolds linked rows/headers and historical embedded/array holds | Incoming entries with original coverage, expected base and blockers; incremental unresolved index. | 2 |
| Refused feed rows, including delete payloads | Same incoming entries with policy reasons/reevaluation triggers; never a metadata-free skip. | 2 |
| Versionless V2 removals, authored departures, departure marks, onRemoval | Durable connection-departure events, distinct from global tombstones and content versions. Move adapter settlement and retention decisions behind the dispatcher. | 1 centralizes, 2 owns |
| AsideMarks / passed-over-paths | Owned inventory-discovery obligations preserving disk/wire path and blocker. These are not caches; missing identity may require a new manifest. | 2 |
| file-retry rows | Attempts/deadline/reason on the actual owner, not the latest user of a path. During staged rollout a facade routes to incoming inbox or legacy outgoing owner. Unknown local reads get local observation identities. | 2 incoming, 3 outgoing |
| State journal with original body/key/origin | Immutable request envelope with child entries and uncertain-result state; no independently replayed scheduler. | 3 |
| push-receipt rows | Result evidence attached to the exact identity/intent; merge compatible feed echoes without granting stale receipt authority. | 3 |
| pull-write and pull-evict records | Owned effect/substep plans with exact source/victim bases and installation receipts; physical stage resources remain on the host. | 2 incoming effects |
| StagedChanges/deferred-changes | Approval entries with displayed revision and saved base. Stage 2 can retain a legacy approval owner linked to an incoming entry; only that owner accepts the decision. Stage 3 transfers it. | 3 |
| Held/noted deletes and delete tally | Pending decisions on outgoing entries; keep deduplicated policy accounting as accounting, not replayable work. | 3 |
| v2-directories pending/incoming/refused/removals | Directory entries and dependencies, with directory identities. Split incoming ownership from uncertain outgoing directory requests. Installed inventory remains baseline data. | 2 / 3 |
| Generation/scope, membership and collision state | Namespace/eligibility constraints and inventory triggers. Ledger/scan hints remain baseline/observation data, not another work queue. | all |
| Node conditional and code-group recovery journals | Host physical safety evidence referenced by an owner. Retain physical rollback/recovery; only settlement may adopt a remote clean base. | 1 routes, 2 / 3 binds |
| assertLocalSafety and disconnect/retire/re-enroll readers | Query unresolved ownership, approvals, effects and uncertain requests across active inbox and still-owned legacy families. | bridge before 2 activation; completion in 4 |

## 3. Data model

Use a versioned InboxRepository sharing the scoped transaction capability with the tracked ledger: SQLite tables, IndexedDB object stores and Memory maps. No best-effort metadata fallback for activated families. A host without atomic isolation/index capabilities stays on the stage-1 engine.

```
Namespace = connectionId + serverGeneration
ContentKey = Namespace + fileId + versionId
EventKey = Namespace + feedSequence + eventKind + fileId
LocalKey = Namespace + durableLocalId + intentRevision
InventoryKey = Namespace + durableDiscoveryId

Header { schema, familyOwners, migrationEpoch, inventorySession? }
Entry { key, revision, kind, immutablePayload, origins, coverageRefs,
        expectedSource, targetWirePath, expectedOccupants,
        eligibilityRevision, phase, blockers, retry, claim,
        effectRefs, requestRef, approvalRef, resolution }
Page { pageId, namespace, coveredInterval, snapshot?, continuation?, childRefs }
Inventory { key, reason, diskPath?, wirePath?, blocker?, snapshotHead?,
            continuation?, childRefs, completionProof? }
Request { id, immutableBody, idempotencyKey, origin, childRefs, status, results }
Effect { id, owner, sourceBase, victimBases, target/from, stage/receipt,
         publicationEvidence, phase }
Resolution { outcome, proofRef, settledRevision, notificationId }
```

Content identity and event identity are different. Every incoming delivery has EventKey; compatible content evidence can refer to ContentKey. In particular a versionless removal uses connection + generation + server cursor + removal + file ID. Persist its original path, timestamp and type; never fabricate a version or attach departure semantics to the last content version. The protocol supplies a positive event cursor. A manifest item instead belongs to its snapshot/page identity. Scope revisions are eligibility constraints, not new remote identities.

V2 changes must return departure metadata without deleting files, retiring ledger entries, consuming authored-departure marks or calling a mutating onRemoval hook. The settle handler obtains the current overlapping-connection retention decision, records its authority/revision and revalidates before the conditional effect and ledger commit. Replace any destructive host callback with a query plus idempotent committed notification. Retaining bytes due to another connection does not mean globally deleting the identity; directory departure uses its own kind/dependencies. Repeated deliveries deduplicate by EventKey even when no content version exists.

Version IDs are opaque. Supersession follows authoritative feed ordering/request-result relations within a generation, never lexical comparison or cursor alone. Outgoing creates use LocalKey until a server result binds the real identity. Uncertain batches retain their original body, order and key. A departure and a content installation must not collapse merely because they reference the same file.

Index ready deadlines, namespace/identity, physical path, request/effect owner and unresolved sequence. Use the filesystem's reported path key for case/normalization aliases in every preflight, publication check and ledger write; paths are resources, not identities. Claims expire without resolving entries. Maintain waiting counts incrementally. Resolved evidence is compacted only after dependent effects, decisions, notifications and lifecycle checks no longer need it.

## 4. One settle operation

Stage 1 supplies this operation over legacy repositories; stages 2 and 3 change the repositories, not its safety rules.

1. Claim an owner/revision and deterministic source/destination resource set. Refresh generation, scope, approval and dependency authority. Reject commands against a retired owner epoch.
2. Read current source and destination owners through the shared physical-path fence. Reconcile stale requests/results instead of replaying blindly. Fresh authoritative replacement may explicitly evict a proven clean occupant; an old receipt may not.
3. Plan kind-specific work. Adoption still proves absence of an unpushed local edit. Removal still distinguishes connection departure, retention and global deletion. Approval only covers its displayed revision.
4. Persist preparation before submitting an immutable request or allocating recoverable effects. Use conditional filesystem publication through the pause fence. Keep host installation evidence; matching bytes plus an intent are insufficient.
5. Revalidate after asynchronous work. In one fresh scoped transaction check revision and both owners, publish ledger/evidence, resolve or block the entry, retire its retry, update indexes/accounting and enqueue notification. The same commit service computes/writes the applied frontier from the complete unresolved set. No handler writes cursor or retires work independently.
6. Deliver deduplicated notifications and clean owned evidence after commit. Failed cleanup becomes owned maintenance, not an ownerless retry timer. Interrupted publication reuses evidence rather than assuming that the filesystem rolled back with the database.

Incoming page capture atomically stores all items (including removals), coverage and continuation before they can settle. Chunked pages retain an envelope proving which parts are durable. The commit service cannot acknowledge unrepresented or queued work. Inventory records its true head before interruption and does not imply feed coverage until its snapshot is complete.

Per-file transient failures retain 5-second doubling backoff capped at 5 minutes; explicit retry targets the owner. Policy refusals preserve quota/cap/scope invalidation semantics and reasons. Operational database/network/auth failures remain retryable cycle failures, not permanent review decisions. Malformed recovery evidence becomes visible review only for its affected resources. Keep bounded parallel transfers; the shared commit service is not a global transfer lock.

## 5. Migration and activation protocol

### Per-family import

Freeze that family's writers under exclusive engine ownership, write a resumable migration manifest, and import into an inactive epoch with deterministic IDs. Preserve raw legacy evidence. Before activation validate counts, coverage, owner references and indexes. Atomically switch the family owner; crash before that transaction leaves legacy authoritative, crash after it leaves inbox authoritative. Legacy-looking APIs become facades for the selected owner. Never run a fallback legacy scheduler because inbox work is blocked.

Import every historical hold shape: manifest-embedded holds, first-held checkpoint, array header, linked rows, both/neither, complete/interrupted inventory. Repair zero heads from matching snapshot evidence before any scope rewind. Import refused tombstones intact. A legacy cursor is not proof of missing payloads; recover a bounded uncertain feed interval only where it really identifies the missing work. Preserve unresolved raw data on network/DB failure, without resetting valid progress to zero.

**Passed-over-paths:** import every disk/wire pair into an InventoryKey, even without file ID or sequence. Preserve blocker/filter context and a stable import ID. When the blocker disappears or eligibility changes, that owner schedules discovery, including a full manifest if the server cannot query the missing identity. Complete the obligation only when discovery has durably created child work or proved absence, or an explicit policy decision resolves it. A crash after discovery but before completion reuses the inventory session. No legacy AsideMarks timer or setCursor(0) remains active after this family switches. A necessary fresh inventory is not an excuse to replay the feed from zero.

Outgoing import retains immutable envelopes, result snapshots, stage IDs and authored origins. Match retries to exact intent owners; malformed/ownerless evidence becomes review, never runnable work. Legacy approvals remain authoritative until their own stage-3 switch, referenced rather than copied as a second actionable approval. Generation changes archive old authority while preserving local captured bytes; widening scope never deletes an unresolved import.

### A fence existing binaries actually reject

A new inbox metadata key is NOT a downgrade fence. Current SqliteStateStore opens legacy tables without an engine-schema check. Current Node config readers do reject a versioned abele.cli envelope whose schema is not 2 (`config.ts`, readConfig/readConfigDescriptor). Use that existing rejection, not an invented minimum-version field old readers ignore.

Proposed Node/CLI activation uses a new required envelope schema (3, subject to schema allocation), containing preserved connection/descriptor data plus migration/profile identity. Before any family becomes inbox-owned:

1. Stop old engines, acquire exclusive profile ownership and persist/fsync a migration manifest with original config digest, database identity, epoch and intended fence. Preserve a non-active backup; do not leave a second discoverable legacy config. Locking must exclude already-running old writers; config rejection only protects new starts.
2. Write the new envelope to a temporary file, fsync it, atomically rename over the active config, then fsync its parent. Do this for every supported entry config pointing at the ledger. New startup understands the migration-only envelope; old startup must reject before opening an engine or offering destructive recovery.
3. Fence direct old SDK database opens too: migrate the ledger to a versioned table in a database transaction and leave the old entries name as an incompatible guard schema (no legacy path/file columns). Current legacy constructor prepares queries against those columns and therefore fails, rather than silently creating an empty legacy ledger. The new adapter reads the versioned ledger. Preserve cursor/journal/metadata via the new adapter for families not yet migrated. This is a proposed schema design, gated by tests against actual old constructors and lifecycle tools, not just a new adapter's version check. Arbitrary SQL bypass is outside the binary compatibility guarantee.
4. Commit the durable database fence before the family activation transaction. Record both fence identities in migration state and verify them again when switching ownership. A config-fenced/database-old crash resumes migration with legacy records intact and no inbox execution. A database-fenced/inactive crash resumes validation. An active crash runs only the selected owner. Never automatically restore a legacy-readable config after activation; restoring a stale backup must still meet the database rejection fence.

Config and SQLite are not one atomic resource: the ordered, durable fences deliberately create a recoverable inactive interval. Inject crashes at every write/rename/fsync/DB commit. Do not delete either evidence or backup in that interval. Before activation rollback is an explicit validated operation under the lock, allowed only if no family ever activated; after activation downgrade needs reverse migration or a consistent backup plus reconciliation.

Plugin IndexedDB activation needs an equivalent **demonstrated old-reader rejection**. Proposed direction is a database version bump that makes an old explicit-version open fail with VersionError, plus closing existing connections and fencing lifecycle entry points. Audit its actual open/version/config behavior first: an old unversioned open would defeat this proposal. If no rejecting path can be proven for shipped plugin versions, that host stays on stage 1 until a compatibility bridge is deployed; no optimistic A7 activation. Memory stores need epoch revocation but no persistent downgrade format. Host activation is independently gated; Node readiness does not authorize plugin activation.

### Lifecycle bridge before cleanup

Stage 2 must include a minimal inbox-aware safety query before activating incoming ownership. assertLocalSafety, disconnect preparation, retirement, force/recovery paths and re-enrollment must consult it plus each still-owned legacy family. This is required even while legacy records are archived: the archive becomes stale once new inbox work arrives. An unknown schema, unreadable store or incomplete migration blocks destructive lifecycle work, with a retryable diagnostic.

Stage 4 completes those readers and removes legacy scans only after tests prove they see inbox-only approvals, uncertain publications, installation effects, departures, inventory obligations and delete decisions. Define explicit transfer/archive/cancel policy for each dependency; no blanket resolution during disconnect. Recheck safety at lifecycle commit under the same exclusive profile epoch so a clean preflight cannot race new work. Retiring a connection must not retire evidence owned by another covering connection.

## 6. Four independently shippable stages

| Stage | Scope and shipped boundary | Release gate | Worker hours |
| --- | --- | --- | ---: |
| 1 — central settlement behind existing stores | Route incoming, outgoing replay, staged/adoption, directory/departure and recovery publication through one dispatcher/commit service and authority checks. Keep all legacy stores and applied cursor. No inbox activation or format migration. | Red regressions plus handler-registration audit: no effect/adoption/ledger publication bypass; exact/case/Unicode ownership contention, versionless retention, pause and existing semantics pass. Can ship alone. | 14–22 |
| 2 — incoming inbox | Repository and incoming migration; feed/manifest coverage, holds/refusals, incoming retries/effects/departures and AsideMarks inventory ownership. Outgoing journal/receipt/approval owners remain legacy behind the stage-1 dispatcher. Keep applied cursor. Install rejecting host fences and minimal lifecycle bridge before activation. | Historical migration/crash matrix, real old-binary rejection, inbox/legacy cross-owner interactions, inbox-only lifecycle safety, linear persistence and no gratuitous replay from zero. Enable per proven host; others retain stage 1. | 28–42 |
| 3 — outgoing inbox | Import immutable requests, uncertain journals, receipts, outgoing directory work, approval/delete decisions and remaining retries. Merge receipt/feed evidence with exact identities, retaining physical journals. | Unknown-result/partial-batch/echo/approval oracle, crash every settlement and family activation boundary, deduplicated delete accounting, no stale-owner or ownerless scheduling; stage-2 profiles upgrade independently. | 22–34 |
| 4 — lifecycle completion and legacy removal | Finish lifecycle query/decision APIs, validate all consumers, compact resolved evidence, remove obsolete queues/readers/writers and archives under retention policy. Keep physical recovery journals. | Each disconnect/retire/re-enroll path refuses unresolved inbox-only work; completed work permits safe lifecycle progress; crash-safe cleanup; static ownership audit finds no legacy scheduler or direct cursor publisher. | 12–20 |
| **Core + Node/CLI implementation and targeted tests** | | | **76–118** |

Allow **16–24 worker hours** for independent review corrections (total **92–142**). Plugin capability, rejection-fence and lifecycle integration is separately **12–20 worker hours**, apportioned roughly 6–10 to stage 2, 4–6 to stage 3 and 2–4 to stage 4, plus device validation. Studio scheduling and manager landing/release waits are elapsed time, not worker hours. Re-estimate after stage 1 inventories host entry points and confirms downgrade feasibility.

**Already done in D-149–D-154:** shared replayAuthority source/destination checks; adoption and ledger-publication fencing; normalization collisions held per item; pathOccupant using the host physical key with indexed transaction-aware candidate lookup. Conditional effects, installation evidence and pause fencing also exist. Stage 1 reuses these, rather than implementing another competing fence. What remains is exhaustive routing (notably adapter-side departures), a single settlement/commit owner, and removal of independent retirement/cursor decisions. These fixes are primitives, not an implemented inbox or proof that every call site is centralized.

Each stage can stop at its release boundary with all existing features intact. There is no requirement to activate outgoing ownership when incoming ships, and no legacy deletion hidden in activation. Subsequent stages use explicit upgrades, not fallback queues or dual schedulers.

## 7. Deletion plan

- Stage 1 deletes duplicated authority/settlement decisions once all callers use the shared service; keeps legacy persistence adapters.
- Stage 2 disables incoming PullHolds/refused independent schedulers, checkpoint-embedded hold writers, direct adapter departure effects, AsideMarks rewind scheduling, incoming retry sweeps and separate pull-write/eviction settlement loops. Keep versioned import readers and archived records until lifecycle gates allow cleanup. Pure planners and host effect helpers remain.
- Stage 3 disables independent resumeReceipts/resumeJournal settlement, outgoing retry retirement, StagedChanges authoritative lists and directory outgoing queues. APIs become inbox views/commands; immutable protocol requests remain.
- Stage 4 deletes legacy keys/archives and decoders according to the tested migration/retention policy, obsolete lifecycle scans, direct cursor writes and competing bookkeeping. Physical conditional/code-group journals, ledger/scan hints, policy tallies, conflict copies and generation protection remain. One logical authority does not mean a giant JSON document or removal of necessary physical evidence.

## 8. Tests, risks and acceptance evidence

Failing tests precede each replacement; keep current regressions and assertions, including the approved bounded cursor. No expectation needs changing for a new cursor meaning because this rollout does not introduce one.

**Independent sequential oracle:** apply raw events one at a time in a small model that does not reuse production coalescers/fence helpers. Generate create/modify/move/case-move/delete/recreate across identities sharing NFC/NFD/case aliases; mix local edits, holds, refusals, scope marks, guarded deletes, untracked occupants, approvals, receipts and uncertain requests. Include versionless connection departures with overlapping coverage and authored departures. Randomize pages, walking/following resume and family migration stages. Compare quiescent bytes, ledger ownership and unresolved reasons, allowing documented conflict naming and safe coalescing. At intermediate points assert no lost local edit, no cursor past unresolved work, no uncovered captured page, no duplicate physical owner and no ownerless runnable obligation.

**Crash every await:** cut page fetch/manifest fetch, capture transactions, pre-publication microtasks, claim/revalidation, request/answer persistence, stage allocation/publication, ledger commit, notification and cleanup. Restart from durable state, crash again at each recovery boundary, then quiet-restart. Also inject saves and destination replacements at every await, including move destinations. Revoked process epochs cannot publish. Require convergence or visible blocked/review state, never silent loss or infinite retry.

Stage-specific matrices:

- Stage 1: D-110–D-120 and D-136–D-154; every handler enters shared authority and commit services. Versionless removal must not produce effects during page decoding, including directory removal and overlapping retention changes.
- Stage 2: all legacy shapes × rewind/no rewind × interrupted/complete inventory × crash at every import/fence/activation boundary. Import passed-over marks with no identity, remove the blocker with **no new feed events**, and recover the remote file through owned discovery. Include a crash between inventory completion and obligation resolution. No reset to zero merely to trigger inventory.
- Stage 2 downgrade: launch actual supported old Node/CLI binaries with original/replaced configs and migrated databases, including direct old SDK open; assert rejection before mutation, no auto-bootstrap/retirement escape. Repeat plugin tests with shipped old readers and blocked live connections. Fail the release gate if the proposed fence does not reject; metadata-marker-only tests do not count.
- Stages 2–4 lifecycle: each disconnect, retire and re-enroll command sees an unresolved inbox-only dependency after deleting its legacy fixture; also test mixed owners, migration-only state, corrupt/read-failed inbox and concurrent enqueue at lifecycle commit. Once resolved, safe lifecycle progress must succeed. Do not only test permanent rejection.
- Stage 3: response lost, partial result, echo before receipt, result before local settlement, newer destination owner, approval revision change, crash during child retirement. Immutable request bytes/key and original source authority survive every replay.
- Stage 4: cleanup/compaction crash replay retains required coverage, disposition proof and physical resources; no old reader silently ignores remaining work.

Performance/port gates: 10k conflicts give linear serialized bytes/writes; 250k holds use bounded stacks and indexed pagination; large inventories start useful work before unrelated enumeration. Preserve R2 hash reuse, quota/cap refusal invalidation, per-file retry backoff, early pull, delete guard and group semantics. Large slow-transport pause tests keep per-lane latency bounds. Measure CPU, bytes and listings as well as scheduler steps. Memory/SQLite/IndexedDB contracts verify scoped transaction isolation, unrelated writes surviving rollback, atomic entry/index/cursor commit, and epoch revocation immediately before publication. Document checked-host and POSIX open-descriptor limits honestly.

Mutate the implementation deliberately to prove properties detect cursor-before-capture, resolve-on-base-mismatch, omitted alias owner, removal effects during decoding, missing AsideMarks import and retry retirement before owner commit. Save minimized deterministic traces. Run bounded CI properties/affected suites on Studio; manager runs full suites before landing, plugin worker verifies host/device behavior. This plan runs none of them.

Main risks are cross-resource activation ordering, legacy unknown-identity obligations, shared-connection retention races, uncertain batch ownership, lifecycle command bypasses and quadratic indexes. Stage gates isolate those risks instead of coupling a cursor API change, all migrations and cleanup in one release. The strict host activation requirement may delay one host without blocking stage-1 safety improvements or proven-host stage-2 releases.
