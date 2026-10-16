# Restored vault and profile reconciliation

`abele-sync reconcile --dir <vault>` verifies all selected local content once and runs
sync under the ordinary vault lock. Every outgoing file deletion is held, including
a single deletion and connections configured without the normal bulk-delete guard.
`status` and `status --json` expose the durable reconciliation phase and reason.
Use the existing `deletes` review commands to confirm the shown set or restore it.
The phase becomes `complete` after a successful cycle with no held deletions.
The core host equivalent is `await engine.reconcile()`.

## Automatic detection

Before journal replay or pulling over tracked paths, core checks for:

- several selected tracked files whose content differs from their ledger digest and
  whose timestamps went backwards; timestamp changes alone and a single backdated
  edit do not establish that a vault was restored;
- a backdated binary edit that diverges from a newer remote version whose clock is
  even older. Version identity proves divergence; the clocks only reveal that normal
  binary resolution would replace the remote variant. Reconciliation preserves both;
- tracked paths previously observed missing that have reappeared;
- a server head ahead of the local cursor with missing tracked files at startup,
  or an unresolved destructive publication journal. Retries of a batch known to the
  same live engine retain their ordinary idempotent replay.

These are conservative indicators. An ordinary offline client can be indistinguishable
from a restored profile; an ordinary deletion while the server advanced can therefore
require review. Server wall clocks and journal ages are not used as authority.
An old confirmation is archived and invalidated when reconciliation begins, including
when an advanced-server snapshot already contains an active reconciliation and decision.
Paths governed by staged approvals (including source, destination and a settled local
outcome) are not restore evidence. For a small set of missing files, a newer server head
for the same identity is handled by normal edit-beats-delete resolution. An unchanged
remote head plus unexplained local absence still requires review. Use the explicit
reconciliation command for a known restore that has no automatic evidence.

Reconciliation rehashes all selected local content, protects detected edits before pull,
and disables rename inference from historical absence. Notes retain normal merge/conflict
handling. Divergent non-note content also gets a deterministic visible recovery copy,
because normal binary conflict resolution retains the older variant only in history.
The copy holds whichever variant the normal timestamp rule would replace, so clock
skew cannot hide the causally newer remote bytes. Copy installation uses bounded streaming where available and does not overwrite a
different existing copy. A retry reuses a copy with the same bytes.

Destructive file journals are retained under `reconciliation-journal:<idempotency-key>`
and removed from the replay slot transactionally. Their exact operations and keys remain
available as recovery evidence. Saved delete decisions are likewise archived. A mixed
journal containing content operations is only retired if those exact bytes are still
recoverable from disk. Otherwise sync stops with the original journal intact and requests
manual recovery. Unreadable content or a recovery copy outside the selected scope also
stops reconciliation and preserves the source.
When current-generation history shows a delete directly after a journal's recorded base,
archiving also records that deletion in the recent-delete window,
atomically and once. No destructive request is replayed to discover this evidence.

## Normal content revalidation

Ordinary cycles rotate through at most 16 tracked files, using a 16 MiB sweep budget.
One oversized file can advance per cycle. Hashing uses host streaming fingerprints;
the sweep cursor is durable and sorted independently of filesystem enumeration order.
For a stable selected inventory of N files, every tracked file is revisited within at
most N successful cycles (usually much fewer). A read failure remains retryable on
later sweeps. Changed metadata still triggers ordinary immediate hashing.
Read-only status does not advance the sweep. Full hashing occurs on reconciliation,
not on each successful normal pass or each pass waiting for delete review.

## Plugin integration

After vendoring this core, the plugin must persist the metadata keys, surface
`EngineStatus.reconciliation` and held-delete counts, provide the explicit action through
`engine.reconcile()`, and keep fallback/foreground cycles running so quiet files advance
through the sweep. Fingerprints must read content rather than cache solely by size/mtime.
Streaming copy ports are needed for recovery of large non-note conflicts; without them
core stops above its small-file fallback cap. Startup code that replays publication
before the engine runs must prepare the client against the ledger to fence a changed
server generation, then call `fenceRestoredJournal(state, head, fs)` before replay.

Server-generation recovery and restored-vault recovery now use one content reconciliation.
The generation transaction archives the prior local reconciliation metadata and retires its
ledger, journal, cursor and decisions, then requests one full content pass. Retired members
remain comparison evidence for local restore detection and scoped publication; their old
IDs never regain delete authority. After the manifest, divergent binary variants are copied
even when local bytes equal the retired ledger digest. Completion clears generation flags
and content reconciliation atomically, after all pending or held work is accounted for.
CLI startup checks local installation material before any HTTP. It performs the generation
handshake before recovering retained remote effects; ordinary commands with no such effects
leave preparation to the sync cycle.

Directory journals remain separate from file publication journals.
Directory publication is deferred during file reconciliation so a recursive operation
cannot bypass file holds. An unresolved destructive directory journal against an advanced
server stops with a manual-review error, preserving its protocol document unchanged.
