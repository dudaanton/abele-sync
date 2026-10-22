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
