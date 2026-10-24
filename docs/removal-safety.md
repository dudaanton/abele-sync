# Removal safety: capture, decide, retire

Design for the removal review of the 0.3.5 candidate, updated with the manager's
D-152/D-163 decisions. Implementation and verification are recorded in the report.

## Findings

Node already renames a public victim into a private conditional-operation folder.
The remaining problem is that it treats an asynchronous ownership callback as
permission to destroy that capture. Subsequent asynchronous content checks can
outlive that permission. Adding another callback only moves the window.

The core also has a separate compatibility route which moves each removed file
into an unowned retained-removals directory. That route never completes its
resource lifecycle. Successful replay cleanup has the converse problem: its
retirement marker is durable, but without an optional afterCommit callback it
never recognizes that fact and never cleans up.

There are two distinct authorities: ownership of the public ledger row, and
ownership of the captured object. They must be transferred by a durable decision,
not inferred from content equality or from an asynchronous boolean callback.

## One operation owner

Use an immutable operation id and one authoritative decision record. Its identity
includes the connection/generation, entry point, exact source ledger tuple,
source path and observed object identity when available. The record also names
the host capture receipt, expected content, creation time, accounted bytes and
phase. Unknown identity must remain unknown, not be inferred from equal bytes.

Phases are prepared, captured, committed, restoring, retained and retiring.
The host's fsynced capture journal describes filesystem progress for that same
operation id; it does not grant independent ledger authority. Recovery joins the
two records by id. Neither an orphan journal nor a matching hash grants deletion
permission. There must be no second independently reusable removal intent.

Keep per-operation records and a transactional metadata summary/index of pending
ids, phases, timestamps and byte totals. Normal startup reads the summary, then
only unresolved records; it does not hash or recursively enumerate retained
content. Allocation debris and legacy directories require a one-time, resumable
reconciliation, with progress recorded. Malformed or foreign evidence fails
closed. Do not rewrite a whole retained-content inventory per removal.

## Capture and commit protocol

1. Persist prepared ownership before touching the source. Allocate an exclusive
   private directory on the same filesystem. Atomically rename the public victim
   into it, then fsync both parents. Never unlink a public path based on earlier
   stat/hash results. The capture result must distinguish absence, capture,
   refusal and uncertain I/O, rather than return one success boolean.
2. Compare the captured object with the expected object/content. A replacement
   captured before the rename is refused; a replacement created at the public
   name after the rename is never touched. Persist the captured receipt before
   returning it to core. A crash during capture is resolved from the host journal.
3. In the existing isolated state transaction, validate the exact source owner,
   path aliases, relevant holds, generation, incoming/outgoing decision and
   capture receipt. Publish the ledger transition and the committed removal
   decision together with their existing settlement/frontier updates. A root
   mutation during this work must invalidate transaction commit. Do not add a
   parallel owner or bypass A7's existing settlement publication.
4. Only a durably committed decision authorizes disposal of its named private
   object. Later ledger owners refer to public objects, never inherit that
   operation's private capture. Finalization uses the receipt, not the original
   public path. There is no authorization callback followed by destructive work
   against the current public owner.
5. A refused or rolled-back decision restores exclusively. For regular files,
   Node's existing link-if-absent, fsync-parent, unlink-private sequence is the
   available no-overwrite move equivalent; ordinary rename would overwrite.
   Occupied originals keep the capture as a private conflict copy under the same
   owner id. Never silently discard it because the occupant has equal bytes.
6. Mark retiring before byte cleanup, then remove the owner/index entry only
   after cleanup is durably complete. Repeating any step must be idempotent.

Capture is reversible and may precede the transaction; destruction may not.
If a public save lands after the committed decision, it belongs to the next
operation and survives. If the decision cannot commit, the old capture remains
recoverable even when restoring its original name is impossible.

## Important host limit: rename does not freeze an inode

A process holding a writable descriptor can still change an inode after it is
renamed into quarantine. Other hard links have the same property. Existing Node
tests already exercise a write through such a descriptor during authorization.
Private path ownership excludes name replacement; it does not make content
immutable. Stat/hash/stat followed by unlink cannot provide that stronger claim.

The approved guarantee is bounded retention, not exclusion of external writers.
Every authorized victim remains private for at least 24 hours. Immediately before
reclamation compare identity (when available), size/mtime and content hash with
the authorized content. Changed bytes restore exclusively, or become a visible
conflict copy beside an occupied original. They are never deleted by retention.
Writes through a descriptor held past final reclamation are the explicitly
accepted D-163 residual.

## Cleanup without afterCommit

afterCommit is an optimization for acknowledging a known outermost durable
commit, never the only cleanup trigger. A retiring record reloaded from the root
durable store authorizes idempotent cleanup of its exact resources. Clear only
the matching record after cleanup, preserving any replacement intent.

A read-your-writes read on a transaction handle is not that reload. Both current
root stores and transaction handles advertise transactionScoped, so that flag
cannot distinguish them. Introduce an explicit root recovery boundary which
loads committed retirement receipts before dispatch; transaction-scoped callers
only queue retirement and leave cleanup to that boundary. Do not change
afterStateCommit to call acknowledgements unconditionally: raw outer rollback
would then lose private bytes. Legacy exclusive stores use the same root reload
boundary after their outer transaction has returned.

## Retention and connection retirement

Committed captures remain for a minimum of 24 hours and are reclaimed at seven
days, or oldest-first when the host-configurable byte cap (default 1 GiB per
vault) is exceeded. Younger captures are never reclaimed to satisfy the cap;
report the excess. Each reclamation first verifies the authorized content.
Unique conflict bytes restore exclusively or become visible conflict copies;
they are never retention garbage. Uncommitted captures restore rather than
become eligible merely through age or quota pressure.

Connection retirement must drain committed cleanup and transfer still-retained
conflict ownership to a durable local retention owner before removing connection
state. It must not bypass the current artifact blocker by ignoring files. That
transfer preserves enumeration, accounting, original provenance and subsequent
policy cleanup. Support both default and separate state directories. Legacy
retained-removals directories must be adopted conservatively, not silently
deleted or left permanently outside accounting.

## Entry-point coverage

The implementation/test registry must include:

- Pull deletion, including held/replayed deletion.
- Pull source cleanup when the destination already contains the incoming bytes.
- Pull eviction of another tracked file from the destination.
- Push receipt settlement which discards the old source beside an existing target.
- V2 scope/membership departure removal, including replay.
- Displaced victims from conditional write/install/move publication and recovery.
- Empty-directory removal, preserving its empty-only rule and directory identity.
- Private stage/installation cleanup, using committed resource ownership.

These callers must share the capture/decision mechanism. Merely fixing
PullPlacer.clearPath leaves push/departure removals outside the guarantee.
Older hosts lacking the required capture/restore capability must refuse safely;
they must not keep creating anonymous retention directories. Lack of inode
identity alone is not a reason to retain every successfully committed removal.

## Verification plan

Write failing reproductions before implementation for the post-authorization
equal-byte owner replacement, metadata cleanup without afterCommit, and repeated
compatibility deletions accumulating retained bytes. Add a table-driven test
over the entry-point registry above, injecting replacements before capture,
after capture and before decision commit. Assert the new owner survives, the
captured bytes are restored or owned, and a failed decision does not advance its
settlement frontier. Keep the existing open-descriptor regression.

Crash cuts cover prepared-only allocation, rename before capture acknowledgement,
commit before cleanup, restoration link before private unlink, retention transfer
and cleanup before owner removal. Include raw outer rollback without afterCommit,
replacement intent during cleanup, repeated restart, bounded startup reads,
retention accounting, quota refusal and both connection retirement layouts.

Run only related tests locally with maxWorkers=2, changed-file lint/format and
affected package types. Final Studio/APFS and Linux guardian gates include both
real daemon/server e2e files and the server integration tier. Record exact tip
provenance and guardian cleanup; no deployment is part of this task.
