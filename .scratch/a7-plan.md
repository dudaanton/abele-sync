# A7: one durable inbox and one settlement path

Plan only. Baseline: `0073662`, branch `work/pause-abort-v2`. No implementation or test execution is included in this change. The design uses our existing protocol, safety rules and host contracts; it does not copy another implementation. It covers D-110–D-120 and D-136–D-149 as a class, including outgoing uncertain requests, not just incoming holds.

## 1. Decision and invariants

Replace independent obligation stores with one transactional inbox. A hold, refusal, deferred approval, retry, receipt and uncertain outgoing operation are states/evidence of inbox work, not separate queues that can retire one another. Paths are mutable properties and collision resources; they are never the identity of a remote file.

**The cursor changes meaning.** Today `Puller.persist()` computes a bounded applied frontier from reached head, earliest hold and pending sequence. Under A7 the durable feed cursor acknowledges contiguous metadata ingestion: every event covered by that cursor is either represented in the inbox or has durable settlement/disposition proof. Ingesting metadata and advancing this cursor are one transaction. Placement never writes it. The scheduler resumes network reads from the ingested cursor and unfinished work from the inbox, without rereading history because a file is held.

This intentionally replaces the old rule “cursor <= first unresolved sequence - 1” for the transport cursor. Preserve that bound as a **derived settlement frontier/status**, not another mutable network cursor. It can be computed from ingest coverage and unresolved coverage indices. Do not infer that a high transport cursor proves a receipt was applied or a file was deleted. Update hosts and tests that currently make that inference, explicitly documenting the semantic change. Changing the existing approved cursor formula silently would be unacceptable.

Required invariants:

1. **Coverage:** ingestion cannot acknowledge a sequence interval without durable entries or explicit dispositions covering every delivered event in it. Respect server page coverage tokens; filtered feeds need not have a row for every integer sequence.
2. **Ownership:** no old action may overwrite, remove, adopt, or record a clean base over a newer source identity/version or a replacement destination owner. Bytes equal to a requested version are not proof of identity or installation.
3. **Resolution:** an entry leaves the unresolved set only after applied/proven-already-applied, an explicit policy/user decision, or justified supersession with a durable reference. Clearing a checkpoint, changing a base, expiring a lease or firing a timer is not resolution.
4. **Crash safety:** an interrupted step is redoable from the inbox and host installation evidence. No transaction is held open over network or filesystem work; no claim of atomicity across SQLite/IndexedDB, server and filesystem.
5. **One owner:** retry timing, stage handles, receipts, approvals and uncertain requests always have an inbox owner. Garbage collection is evidence-based, not a second scheduler.
6. **Bounded work:** ingestion and settlement update O(1) entries/index records per item, apart from explicit batch/group size; no serialization of the entire queue per file. Ready work does not wait for a full disk inventory or for unrelated blocked entries.
7. **Pause:** all filesystem/publication and transfer entry points retain the pause fence. A paused run may record the result of an already-started permitted operation but starts no new file operation.

## 2. Current mechanisms and mapping

Verified in current source; this table describes authoritative records separately from caches and safety evidence.

| Current mechanism | Current responsibility | A7 mapping |
| --- | --- | --- |
| `StateStore` cursor; `Puller.reached`, `pendingSeq`, `coverage`, completion barrier | Coordinates feed reads, queued application and bounded cursor publication | Inbox ingestion header and page coverage transaction. Only `Inbox.ingestPage()` advances the transport cursor. Completion barrier becomes coverage validation, not application bookkeeping. |
| `pull-manifest-progress`, `pull-manifest-page`, embedded historical holds | Bootstrap snapshot/head, page continuation, pause progress, scope/generation association | Inbox inventory session: snapshot head, scope revision, continuation and imported page identity. Manifest items become ordinary inbox entries. Session state is not another place to store holds. |
| `pull-held-progress` + `pull-held:<fileId>` (`PullHolds`) | Unresolved incoming versions, first sequence/base, linked index/minimum heap | Incoming entry with a blocking reason and original feed coverage. Durable ready/unresolved indices replace linked hold-specific storage. |
| `pull-refused-progress` + `pull-refused:<fileId>` | Durable refused events, including deletes | Same incoming entry with policy/refusal reason and reevaluation trigger. Tombstone payload retained until resolved; refusal never means skip without evidence. |
| `file-retry:<path>` (`FileRetries`) | Attempts, deadline, error, owner association/quarantine; outgoing intent binding | Retry fields on the owning entry. Directory-prefix policy blocking is a dependency/index over entries, not a second path-owned queue. Scan failures receive a local observation entry when no remote identity is known. |
| `StateStore` journal (`ops`, original key/body, origin, start time) | Uncertain batch request and replay | Inbox request envelope with immutable original body/key and child entry references. Envelopes are part of the same transactional repository, never independently replayed by another loop. |
| `push-receipt:<…>` with op/result/base | Server acknowledgement whose local recording failed | Server-result evidence attached to its entry; feed echo and receipt for the same identity/version are merged as evidence, not duplicated work. |
| `pull-write:<fileId>` | Saved base, target/from, stage/receipt/owner, intended version | Entry effect plan/evidence. Existing host stage or receipt remains a physical resource referenced by that entry. |
| `pull-evict:<fileId>` | Recover ledger after conditional removal | An explicit eviction substep/dependency with exact victim owner/base, recorded with the parent entry. Never an unowned side effect. |
| `deferred-changes` (`StagedChanges`, `Staging`) | User approval, old base and already-settled local outcome | Entry blocked on approval with displayed revision, saved base and decision. Existing APIs become inbox views/commands. Approval applies only to the exact displayed revision. |
| `deletes.ts` held decisions/noted state and recent-delete tally | Approval and mass-delete safety | Pending delete decisions attach to outgoing entries; noted/dirty status becomes a projection. Preserve the recent-delete policy ledger as deduplicated accounting, not as work to replay. |
| `v2-directories` pending/incoming/refused/removals | Directory journal, remote placement, policy refusal and cleanup | Directory-kind inbox entries with physical directory identity and parent/child dependencies. Keep installed directory inventory as baseline state, remove its independent pending queues. |
| Generation/scope reconciliation, membership cache | Namespace ownership, bootstrap requirements, group entitlement | Inbox namespace and inventory-session constraints. Generation changes archive old authority; scope changes trigger reevaluation without erasing work. Membership/entitlement metadata required to apply cached events is retained. |
| Scan hints, tracked entries, normalization/collision metadata | Observations and agreed baseline | Remain data/indexes, not queues. Their writes affecting settlement occur through the same scoped transaction capability. |
| Node conditional recovery and code-group journals | Physical installation/rollback and approval-group durability | Keep host physical recovery evidence. Reference it from inbox effect/group records; do not try to put captured file bytes into the state store. Physical recovery restores safety; inbox settlement alone decides remote-version adoption. |

Initial audit must enumerate all durable keys and `setCursor`, `setJournal`, replay/settlement callers in core, Node and CLI, including legacy writers. The implementation gate is that each has exactly one owner in this table or an explicitly documented non-work role. SDK host consumers must be audited too; replacing only `pullRun.ts` would leave the original class intact.

## 3. Data model and storage contract

Use a versioned `InboxRepository` over the same transactional state store as the tracked ledger. Prefer indexed tables/object stores in SQLite/IndexedDB and maps in MemoryStateStore. A metadata-backed implementation is possible only with equivalent atomic transactions and bounded paginated/indexed access; do not ship an optional-metadata, best-effort fallback for A7.

Proposed logical records (names illustrative, not a wire-format commitment):

```
Namespace = connection + serverGeneration + scope/entitlement authority
RemoteKey = Namespace + fileId + versionId
LocalKey  = Namespace + durableLocalId + intentRevision

InboxHeader { schema, activeEpoch, namespace, ingestCursor,
              inventorySession?, migrationState? }
Entry { key, revision, kind: file|directory|localObservation,
        immutable remote payload / local intent, origins[], feedCoverage[],
        expectedSource, targetWirePath, resolvedTarget?, expectedOccupants[],
        phase, blockers[], retry?, claim?, effect?, requestRef?,
        approval?, resolution? }
RequestEnvelope { requestId, immutableBody, idempotencyKey, authoredOrigin,
                  childKeys[], status: prepared|uncertain|answered, results? }
Effect { effectId, exactBase, intendedVersion, target/from, victimProofs,
         hostOwner, stage/receipt refs, publicationEvidence?, phase }
Resolution { applied|alreadyApplied|superseded|explicitDecision,
             proof/ref, settledRevision, notificationId }
```

- Server version IDs are opaque, not sortable. Ordering comes from generation and feed coverage or explicit request/result relations. Do not use lexical version comparison or `cursor > receipt.seq` as standalone supersession proof.
- An outgoing create does not yet have a server file ID/version. Allocate a persisted local identity and monotonically changing intent revision. On acknowledgement bind it to the real `RemoteKey` atomically, merging an existing echo entry if present and retaining the original request reference. Never invent a server ID from a pathname. A scan failure with unknown identity likewise uses a local observation key until classification succeeds.
- Incoming event, receipt and retry are not competing rows for the same remote key. Merge compatible evidence under an optimistic revision check. Conflicting payloads for the same key are protocol/review errors, not last-writer-wins updates.
- Multiple versions can remain durable until supersession is proven. Maintain latest-per-file and unresolved-by-sequence indices, but do not coalesce by path. Keep deletion identities and side-effect obligations (group departure, victim retirement) even when their content version is superseded.
- `phase` is a small explicit state machine: pending, preparing, effectPrepared, settling, blocked, review, resolved. Retry time/reason and approval are fields, not additional phases with independent retirement. Claims are ephemeral permissions with epoch/revision checks; restart invalidates claims, never the entry.
- Index by ready deadline, namespace/file identity, wire path/physical alias, request owner, and unresolved coverage. Prefix-policy blocks use an indexed parent dependency. Ready selection is bounded/paginated. Persist incremental counters for host waiting/review views in entry transactions.
- Resolved records are compacted only when their effect/request/approval references and notification deduplication no longer require them. A compact checkpoint must preserve replay deduplication and coverage evidence; a high cursor alone is insufficient for this proof. Define a bounded retention policy and recovery tests before enabling compaction.
- The inbox and baseline ledger must share the `tx` capability. Root writes from a transaction call chain remain prohibited. IndexedDB must publish the whole transaction patch atomically, including header, entries and indexes. A legacy host lacking isolation/atomicity must reject A7 activation with an actionable capability error; keep the old engine for that host until upgraded, never run partial A7 beside legacy writers.

## 4. Ingestion, scheduling and the single settle algorithm

### Ingest

1. Fetch bounded metadata pages outside a transaction, checking pause and namespace. Validate coverage and event shapes. Preserve a review record for a malformed item whose identity/payload cannot be safely interpreted; do not silently acknowledge an unrepresented gap.
2. In one short scoped transaction, verify the expected header/revision, insert/deduplicate all page entries, retain any semantic dependencies, and move `ingestCursor` to the page's covered frontier. If the page must be chunked for host transaction limits, persist a page envelope/continuation and advance only coverage whose full event set is durable. Never advance to the full page end after the first chunk.
3. Manifest pages atomically insert their entries and save continuation at the true snapshot head. Do not treat manifest item sequences as complete feed coverage. On inventory completion switch to feed-after-snapshot only after the entire snapshot's coverage is durable. Inventory may settle already-ingested files while enumeration continues.
4. Coalescing selects work, not deletion of history by convenience. Newest-per-identity heads can supersede older content only when tombstone/path dependencies remain accounted for. Fetch ahead in bounded pages; do not buffer an unbounded feed before doing useful work.

### Settle(entryKey)

All incoming, outgoing-result, staged, directory and recovery dispatches enter this operation. Kind-specific handlers may plan or perform a step; none may retire an entry, mutate a cursor, publish baseline state or schedule a separate replay independently.

1. Claim the exact entry revision and required identity/path resources. Refresh generation, scope, approval and dependencies. Lock ordering is deterministic across source, destination, aliases and conflict paths. Different identities contending for a physical path cannot settle concurrently; unrelated paths retain bounded parallelism.
2. Read current ledger/disk evidence and classify the action. Use the shared source-and-destination identity/version fence, full saved bases where available, fresh target content validation, and conditional filesystem primitives. Recheck after asynchronous preparation. An obsolete base means **reconcile**, not automatically resolve or overwrite.
3. A stale receipt has no permission to replace another identity. Mark it superseded only with evidence of newer authoritative state or an already-applied result; otherwise retain a blocked/reconciliation obligation. For a fresh authoritative feed replacement, plan an explicit conditional eviction of the proven clean occupant as a dependency; never weaken the replay fence to allow arbitrary replacement. Dirty files, guarded deletes and offline rename/edit cases remain protected.
4. If bytes already match, decide whether adoption is legitimate using the baseline/local-edit and identity rules. Equality alone is neither installation evidence nor permission to turn an unpushed edit into a clean base. Reuse held content without a download when permitted.
5. For network work, durably prepare the request envelope first. Submit/reconcile its unchanged key/body; do not split or rewrite an uncertain batch. Store the answer and all child result evidence in an inbox transaction before individual child settlement. Multipart chunks/stages remain owned by that request/entry. A later identity version prevents stale local installation but does not remove the obligation to reconcile an unknown server effect.
6. For a filesystem effect, persist an exact effect plan before allocating/using recoverable stages. Perform the conditional operation outside the DB transaction through the pause fence. Quarantine/restore rules, expected SHA/stat and host tier limits remain unchanged. The effect must produce durable installation evidence where the host supports it; an intent alone proves nothing.
7. Open a fresh short transaction. Verify entry revision, source/destination ledger owners and effect evidence; publish the baseline updates, entry resolution/blocker/retry transition, index/counter changes, owned retry retirement and notification outbox record together. **No cursor write here.** If the transaction conflicts after a physical effect, leave its durable effect evidence and entry for recovery; do not blindly redo or clean up the stage.
8. Emit host notifications from the committed notification record with a stable deduplication ID. External callbacks are at-least-once unless the host acknowledges IDs; do not promise exactly-once delivery across a crash. Delete guard accounting is deduplicated in the transaction, not via callback side effects.
9. Clean up only evidence owned by a resolved entry after its resolution is durable. A crash during cleanup is repeatable and cannot resurrect work. Failed cleanup is owned maintenance work, not an ownerless near-zero-delay timer.

Transient per-file failures update the entry's 5 s doubling-to-300 s deadline; explicit retry clears the deadline on that entry. Refusals await policy change or explicit retry. Persistent malformed recovery evidence becomes visible review on that entry, preserving raw evidence and blocking only its affected identities/paths. DB I/O, auth and connection/server failures propagate to cycle handling rather than being mistaken for permanent per-file decisions. “N waiting”, reasons and due timers are inbox projections.

On startup: load/validate the active namespace and bounded ready indices, recover physical safety for referenced effects, reconcile uncertain requests, then dispatch through the same settle path. A host recovery method may restore captured bytes, but cannot publish a remote clean baseline on its own. Pause gates recovery effects as well as normal work. Keep current pull/push concurrency and byte budgets; A7 is not an excuse to serialize all transfers.

## 5. Migration and rollback

Migration must execute before scope rewind, generation reset, scan or any legacy recovery writer. It is resumable and may require network metadata recovery; no filesystem installation occurs during conversion.

1. Require the A7 store capability, take exclusive engine ownership, record a migration epoch and freeze legacy writers. Inventory all legacy keys and physical evidence references. Use a shadow inbox namespace with deterministic import IDs and a durable migration continuation. Legacy data remains authoritative until activation; shadow rows must not run.
2. Import all historical hold shapes: manifest-header/page embedded `heldChanges`; first-held-only checkpoint; array `pull-held-progress`; format-2 linked records; both embedded and separate records; neither; complete and interrupted inventory; refused equivalents. Repair the historical zero inventory head using the matching manifest snapshot **before** any rewind can remove it. Import duplicates as evidence for one key, preserving earliest coverage and all unresolved tombstones.
3. Where a legacy pointer lacks events, retrieve the bounded missing metadata interval and persist it in the shadow inbox. A network/DB failure leaves migration retryable. If coverage cannot be reconstructed because history expired, preserve the raw authority and enter explicit reconciliation/review; do not invent a zero head or pretend coverage exists. A new inventory may be necessary for proven generation/history loss, but not simply because migration was interrupted.
4. Import journals as intact request envelopes, including original idempotency keys, operation order, origin and answers. Import receipt snapshots, stage IDs, installation receipts and eviction victims without renewing their authority. Link all references before deleting any old key. Merge feed/receipt evidence only by exact namespace/identity/version.
5. Import staged approvals, guarded deletes, directory pending/incoming/refused/cleanup and retry metadata. Match a retry to its actual owner/intent, not merely to whatever now uses its old path. Preserve ownerless or malformed raw data as review evidence; an ownerless schedule is not runnable. Retain existing policy accounting and observation caches separately.
6. Derive the starting ingest coverage conservatively. A legacy cursor or reached head is not proof that discarded historical metadata is present: use the old cursor plus explicitly reconstructable coverage/resolution records. Where necessary refetch only the uncertain interval, durably ingest it, and deduplicate against baseline/evidence. Do not reset a valid feed to zero. Incomplete manifest sessions keep their snapshot head and continuation; scope widening changes reevaluation requirements without deleting imported obligations.
7. Validate counts/references/coverage and rebuild/check indices. In one transaction activate the shadow epoch, install the ingestion header and schema fence, and disable every legacy writer. Crashes before activation resume conversion; crashes after activation run only A7. Cleanup of legacy keys is resumable and happens later, retaining a read-only rollback archive initially.
8. Old binaries must refuse to write an A7 profile. A rollback before activation can discard shadow conversion; after activation use an explicit reverse migration or restore a consistent profile backup plus server reconciliation. Keeping stale legacy keys is not downgrade compatibility. Never dual-write two live authorities.

A server generation change creates a new namespace and archives unresolved old-generation work/evidence for review, retaining captured local bytes. Scope changes do not create a new remote identity; they invalidate eligibility/entitlement observations and inventory coverage as required. No path reuse, version reuse across generations or legacy absent generation marker may bypass namespace validation.

## 6. Code removed or reduced

After migration/capability rollout is proven, delete rather than retain competing fallbacks:

- `PullHolds` linked-store persistence, separate refused-store instance, first-held heap/cursor coupling, legacy import-on-every-pull logic. Keep legacy readers only in the versioned migration module.
- `Puller.save/persist` cursor/hold/checkpoint reconciliation, application-driven `pendingSeq`/completion barrier retirement, independent `retryObligations()` queue walk. Replace with ingest coverage and inbox scheduling. Keep metadata validation, coalescing semantics and pure placement planning.
- Standalone `FileRetries` authoritative rows, recovery-owner discovery/sweep and separate ownerless wakeup logic. Keep backoff/error classification and host-facing views over the inbox.
- `resumeReceipts()` and `resumeJournal()` as independent settlement loops; retain protocol adapters and immutable batch/request recovery under the dispatcher. Remove `push-receipt:*` writers and the second retry-retirement path.
- Independent `PendingPullWrites` / eviction obligation storage and startup loops; retain decoders for migration and physical effect helpers referenced by the inbox.
- `StagedChanges` authoritative JSON list and independent staged retirement; retain approval APIs and UI shapes as projections. Delete the old directory document's pending/incoming/refused/removal loops once directory entries use the dispatcher.
- Direct state/cursor publication from recorders and completion callbacks. Split planners/effect handlers from the sole settlement commit function. Prevent new sites with an architectural test/static check over cursor/inbox resolution writes and handler registration.

Do not delete conditional filesystem operations, physical recovery journals, generation/restore protection, delete guard policy, scan hints, local conflict copies, group approvals, membership validation, transfer budgets, hash reuse or pause fencing. “One inbox” means one logical authority, not one giant JSON blob and not elimination of necessary physical crash evidence.

## 7. Tests and acceptance gates

Build tests before each replacement, keeping every existing regression and assertion unless the documented ingest-cursor semantic change specifically requires replacement. No expected-fail conversion to conceal regressions.

**Independent oracle property.** Implement a deliberately simple sequential reference model, separate from production reducers/coalescers/fence helpers. It consumes raw authoritative events one at a time, tracks identity/version, local edits, explicit decisions and visible conflict copies, and records why an event is unresolved. Generate multiple identities reusing paths with create/modify/move/case-move/delete/recreate; varying versions/content including identical hashes, NFC/NFD spellings, directories, groups and scope changes. Mix outgoing uncertain batches, duplicate/partial results, receipts, incoming echoes, approvals, retries and generation changes. Randomize page boundaries, lane order and pause/restart points. Compare quiescent ledger/visible bytes/decisions with the oracle, allowing documented conflict-copy naming differences and safe coalescing of unobservable intermediate versions. At intermediate points assert no unpushed bytes lost, no wrong owner installed, no uncovered acknowledged event and no ownerless runnable work. The oracle must model safety decisions, not blindly overwrite edits while applying raw events.

**Crash every await.** Enumerate storage reads/writes (including inside scoped transactions), transaction publication, network request/answer persistence, stage creation/append/publication, filesystem effects, callback acknowledgements and cleanup. Run each trace with a cut at every boundary, restart from only durable state, then cut again at every recovery boundary before a quiet restart. Include microtask gaps immediately before transaction publication, root-store revision conflicts and abandoned process epochs. Assert convergence or an explicit still-blocked/review state; never an infinite recovery exception/retry storm. Inject local edits and destination identity replacements at those boundaries, not only process death. Include same-stat edits and saves at both move endpoints.

Required focused matrices:

- Every D-110–D-120 / D-136–D-149 sequence; the D-114 hold-settles/new-hold-on-later-page sequence; stale receipt versus unchanged source plus replacement destination.
- Every legacy persisted shape above × rewind/no rewind × interrupted/complete inventory × crash during every migration step, including activation and cleanup; metadata-only pointer import with transient network/DB failure. Assert no lost obligation and no gratuitous replay from zero.
- Commit accepted but response lost; response stored but child not settled; physical installation succeeds but ledger commit fails; ledger commit succeeds but notification/cleanup fails. Original uncertain batch bytes/key must remain identical on retry.
- Every settlement handler must go through the shared fence. Destination ownership changes during planning, after downloads, and before commit; approvals on obsolete displayed revisions; same-content adoption over offline edits/renames.
- Case-sensitive and insensitive filesystem models, Unicode aliases, directory identity replacement, hard links/open descriptors where the native adapter supports them. Keep honest checked-host limits; POSIX does not provide a universal atomic compare-SHA-and-replace primitive.
- 10k conflicts: serialized bytes and durable writes scale linearly. 250k unresolved entries: bounded page/heap/stack usage, no spread-argument minimum or startup full-queue JSON copy. 33k-file pause/stop fixture: no new transfer/effect after the fence, idle within current permitted per-lane work. Measure real CPU/bytes/listings as well as scheduler steps.
- Port contracts on MemoryStateStore, SqliteStateStore and the plugin's IndexedDB adapter: unrelated task writes survive rollback, closed transaction handles cannot publish, ingest header/entries/indexes commit atomically, recovery cannot publish after process epoch revocation.
- Preserve R2 no duplicate downloads, early useful pull before full scan, server rejection isolation, scope/group semantics, delete guard accounting, bounded multipart concurrency and byte budget.

Use deterministic seeds, save minimized traces, and verify properties catch deliberate mutations (advance cursor before storing an event; resolve on base mismatch; ignore destination owner; clear retry owner before transaction commit). Run bounded CI mode on Studio with the approved resource runner; keep a smaller fixed corpus for review. Do not execute a sweep or full suite on the worker Mac. Manager runs the full core/Node/CLI and SQL suites before landing and the plugin worker runs its adapter/device checks.

## 8. Risks, sequencing and estimate

Highest risks: cursor semantic compatibility, incomplete legacy coverage, unknown outgoing identities, atomic batch receipts, directory/group dependencies, cross-store crash windows, queue/index corruption, and accidental quadratic persistence. The design addresses these with explicit coverage, provisional identities, immutable envelopes, one settlement commit and incremental indices; they still need independent review and red-first evidence.

Implementation sequence and worker-hour estimate (coding, targeted tests and migration fixtures included):

| Piece / reviewable gate | Hours |
| --- | ---: |
| Exhaustive state/caller inventory, invariant/oracle specification and host API agreement | 6–8 |
| Inbox repository, transaction/index contracts and ready scheduler | 8–12 |
| Versioned resumable migration and historical-shape/crash matrix | 10–16 |
| Incoming ingestion, manifest coverage and shared settlement integration | 10–14 |
| Outgoing request envelopes, receipt/echo binding and uncertain batch replay | 10–14 |
| Approvals, delete guard, directories, retry/status and physical recovery ownership | 8–12 |
| Oracle/crash-injection properties, performance/pause checks and regression correction | 12–18 |
| Remove legacy writers, SDK migration documentation and final targeted validation | 4–6 |
| **Core + Node/CLI implementation total** | **68–100** |

Allow an additional **16–24 worker hours** for independent review-driven corrections: **84–124 hours including that reserve**. Plugin IndexedDB capability/schema migration and host status integration are separately **8–16 worker hours**, plus device validation/queue time. Shared Studio waits and manager landing/release work are wall-clock dependencies, not included worker hours. The earlier 16–24 h A7 estimate described a pull inbox only; the requested unification of outgoing journals, receipts, approvals and directory/recovery work is substantially larger.

Land reviewable commits per gate, but activate A7 only when all old obligation writers are either migrated or fenced off and required hosts pass the contract tests. A development-only inactive shadow comparison is useful; two active schedulers are not. Preserve all functionality during rollout. Before implementation, review the cursor API change, strict store capability requirement and downgrade policy with the manager; this plan does not authorize deployment or alter the current engine.
