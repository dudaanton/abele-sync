# Local Unicode paths

Clients compose local paths to NFC at the wire boundary, preserving case. Structural
validation runs after composition and does not repair separators, traversal or absolute
paths. Server validation and the wire schema are unchanged.

Filesystem paths retain their enumerated spelling. Existing parents are resolved component
by component; missing components use NFC. Hosts can implement `listChildren` to recheck
only the affected ancestors. Hosts without that port use a complete inventory as a safe
fallback. Enumeration must retain normalization twins, including empty directories and
file/directory aliases. Existing host containment and write guards still apply.

The `v2-directories` metadata document now writes `schemaVersion: 2`. Directory `path`
remains the server NFC path; `localPath` records the physical spelling. Successful old
records are refreshed by directory identity without resetting their IDs or cursor.
An occupied, unambiguous NFC directory path retains its wire identity even when the
host replaces its inode; the ledger rebinds the local identity without a wire operation.
Local identity is rename evidence only when the canonical source path is absent.
Pending requests retain their exact operation and key, with separate `localPath`
provenance. Uncertain requests replay unchanged; definitive path rejection retires an
old raw-NFD intent before a new request gets a new key. Unknown schema versions and
malformed documents fail without replacing the original document.
An uncertain pending recursive deletion is held with a review error if its canonical
directory is occupied again; its original operation and key remain intact.

Removals now retain `{ localPath, identity, path }`. Cleanup is empty-only and refuses
a replacement identity or ambiguous path. Legacy removal strings lack identity evidence
and remain held in the document for review. Blocked incoming directory items are retained
in `incoming` and retried on later cycles. An old client cannot read this additive strict
schema: downgrading a vault after the upgrade is unsupported. Preserve the document;
never delete it to make an older client start.

`normalization-collisions` stores file winners and losing physical spellings.
`normalization-directory-collisions` stores directory aliases and any trusted physical
winner. A former loser cannot inherit a vanished winner's canonical identity after restart.
Removing all aliases, retaining only the original winner, or renaming the loser to a
distinct wire path resolves the hold. Untracked directory pairs resolve when only one
physical directory remains. Collision metadata is schema-checked and contains no bytes.
Status scans read this evidence without writing while a daemon holds the vault lock.

Local state rekeys run transactionally before replay or pull. File IDs, version IDs and
wire paths remain unchanged. Pending pull intents retain exact physical paths and base
evidence; automatic rekeying skips them. A normalization change during a pending pull
therefore requires the existing recovery proof or manual review, never hash equality alone.

CLI runs with collisions say `sync: partial`; plain status identifies both spellings and
code points. `status --json` returns collision records and reasons. Linux CI requires a
successful real-twin capability probe through `ABELE_REQUIRE_NORMALIZATION_SENSITIVE=1`.
macOS tests probe the filesystem and skip real-twin cases when aliases cannot coexist;
normalization-sensitive memory tests still run.
