# Line-only merge: test expectation changes

This inventory records changes to pre-existing tests for the line-merge and durable
conflict-identity upgrade from v0.2.0. No test was deleted or skipped to enable the
upgrade. Opaque-file timestamp assertions are unchanged. New regression files are
listed separately below.

## Server merge units

`packages/server/tests/unit/merge.test.ts`:

| Test (current title, or original title when unchanged)                         | Change and reason                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| conflicts on different words of the same line                                  | Former character-clean result becomes complete-head conflict. Different words still share a line.                                                       |
| preserves the head when the same words changed                                 | Head-plus-incoming concatenation becomes head unchanged, unclean. Incoming belongs in another file.                                                     |
| conflicts on competing creates with an empty base                              | No concatenation for competing creates.                                                                                                                 |
| aborts without publishing a partially merged same-line region                  | Partially applicable character hunks no longer produce any output.                                                                                      |
| conflicts when incoming edits a line head deleted                              | No resurrection into the head; whole incoming document requires a copy.                                                                                 |
| conflicts when both sides insert at the same spot                              | Competing insertions are separate documents, not adjacent variants.                                                                                     |
| conflicts on same-line edits even when head shifted characters                 | Character offsets do not confer permission to combine same-line changes.                                                                                |
| follows the non-empty side when the other is empty                             | The edit/delete case now also explicitly carries `conflictCopy: true`; clean empty-side cases are unchanged.                                            |
| keeps a head edit inside a paragraph incoming rewrote                          | The exact whole head is preserved rather than also containing incoming's paragraph.                                                                     |
| keeps a head edit to the middle line of a paragraph incoming replaced          | Same whole-document abort rule.                                                                                                                         |
| returns the whole head for a 5000-line document changed entirely on both sides | Replaced character-work spies/concatenation assertions with exact whole-head conflict assertions; the dependency and entire character pass are removed. |
| conflicts without resurrecting text when head deleted everything               | An empty head stays empty; the incoming edit is not published in it.                                                                                    |
| aborts 100 conflict regions of 4 KB each without partial publication           | Whole-document abort replaces the removed character-budget/concatenation assertions.                                                                    |
| returns the whole head around the former character-region size bounds          | Every size around the former character caps must preserve the complete head; there is no character attempt at any size.                                 |
| conflicts on small same-line regions too                                       | Small size no longer makes character merging permissible.                                                                                               |
| aborts all regions including later same-line changes                           | No earlier or later region is partially published after a genuine conflict.                                                                             |

Adjacent-hunk tests retain clean merges for proven disjoint base-coordinate
replacement spans. The former clean expectation for an identical replacement
beside a one-sided insertion now requires a complete conflict copy: the resized
hunk could instead insert before replacing the base line, so positional alignment
is not proof. No test was removed. `merge.property.test.ts` retains its existing
properties and adds seeded insertion/replacement plans for both sides and both
delivery orders, including shared-marker aliasing. Uncertain overlap never
publishes a partial merge. Real v2 regressions verify both complete documents
remain live and repeated delivery reuses one conflict identity. `generatedPaths.test.ts` keeps
its original path-limit assertions and adds UTF-8/extension/uniqueness assertions
for opaque disambiguators.

## Server integration and simulated clients

- `integration/mergeLimits.test.ts`, four existing cases:
  - **refuses delivery when an over-limit merge cannot fit a conflict copy**;
  - **writes no over-quota merge and refuses rather than acknowledging history-only delivery**;
  - **refuses conflicting frontmatter when no conflict copy fits**;
  - **makes no conflict copy the quota has no room for in a vault that copies conflicts aside**.
    History-only `merged` success becomes explicit `quota_exceeded`, with no incoming
    history write. Otherwise old clients would discard pending content without a
    visible copy.
- `integration/scopedMergeOutputs.test.ts`:
  - **refuses rather than acknowledging history when a copy would enter another live grant**;
  - **refuses and preserves the scoped upload when no conflict copy fits the quota**.
    Both replace history-only success with explicit refusal, no history mutation,
    and retained upload proof.
  - **matches personal over-file-limit fallback and rolls all outputs back on late expiry**:
    its second input now changes a separate line so the fixture still takes a clean
    merge/store-put path and actually triggers its late-expiry hook. Same-line
    divergence would correctly bypass generated-blob storage.
- `integration/api.commit.test.ts`:
  - **rejects a bad path and a case collision without aborting the batch**:
    the colliding note create returns `conflict`, not concatenated `merged`.
  - **reports applied without another version when both devices sent identical edits**:
    no redundant merge version for identical bytes.
  - **copies a divergent create once: the same bytes sent again write nothing**:
    one source create plus one conflict-file creation, stable identity on retries,
    not source-history concatenation and auxiliary versions.
  - **a modify over a deleted head whose path another live file took lands at the next free name**:
    fixture names become `DeletedHead.md`/`DeletedHead 1.md`; the shared-vault test
    previously also selected a legitimate conflict copy from an earlier test by
    the overly broad `m` prefix. Exact manifest cardinality remains asserted.
- `integration/api.join.test.ts`, **theirs finds the joiner's bytes already kept by an earlier conflict, and writes nothing again**:
  a baseless colliding create is delivered to its own copy. Later preference
  changes cannot redeliver the same branch into source history. The copy has one
  retained version and the source has no incoming-byte history version.
- `unit/resolve.test.ts`, **8 modify over a head that only moved applies at the new path**:
  the input SHA now differs from the unchanged head, so this still tests an actual
  edit after a move rather than the new identical-byte no-op rule.
- `integration/groupUnavailableRecovery.test.ts`, **retries an operational failure (SQLITE_BUSY) without losing subsequent committed evidence**:
  the injected database failure persists until the test restores the mock, so it
  exhausts the new bounded transaction retries before asserting refusal/recovery.
  The EIO and PostgreSQL-deadlock expectations remain unchanged.
- `integration/migrate009.test.ts`, **upgrades populated 008 and matches a clean install without parked schema**:
  the comparison fixture is now explicitly migrated to 009, matching the upgrade
  under test instead of comparing 009 to a latest install containing additive 011.
- `scenario/conflicts.test.ts`, and its real-core counterpart, change exactly
  these three cases to assert complete original and incoming copies on both devices:
  - **note, overlapping edits, merge mode: original and complete conflict copy converge**;
  - **note in merge mode: competing creates stay in two complete files**;
  - **move onto a path vs a new file there, merge mode: the moved identity stays and the create becomes a copy**.
    Their former expectations concatenated variants in the original. The parity
    test remains unchanged and checks the matching scenario titles.
- `scenario/firstSync.test.ts`, and its real-core counterpart, **links equal files without upload, resolves same-path differences as create vs create, and ends with everything on both**:
  the same-path different note is a complete copy, with exact bytes and an exact
  extra manifest entry. The real core additionally downloads the new copy identity
  from the feed (three downloads rather than two); the simulator's count stays two.

## Real core client compatibility

Only tests changed in core; its production code is unchanged.

- `integration/pusher.test.ts`:
  - **writes nothing and creates no conflict when both sides sent identical bytes**:
    `applied` no-op replaces a redundant conflict result.
  - **drops the synced copy at the old path when a create lands on a file that had moved there**;
  - **keeps an edited copy at the old path when a create lands on a file that had moved there**:
    conflict replaces concatenation; original identity/old-path behavior is still
    checked, and exact incoming-copy bytes are checked through version download.
  - **leaves no entry when a create raced a create, so the next scan creates again**:
    first sent bytes and later typing are two different branches, each with one
    complete copy. The unchanged original is never concatenated with either.
  - A new edited-copy replay case verifies safe refusal and preservation of local
    pending bytes: legacy conflict verdicts cannot describe a changed copy SHA.
- `scenario/adversarialConflicts.test.ts`, all six arrival orders of
  **same-line ... convergence and recoverable originals**:
  three distinct complete variants now occupy the original and two conflict files.
  All six **different-lines** cases retain their clean-merge expectations and now
  also assert exactly one file. Adjacent-hunk fixes were required to satisfy them.
- `scenario/adversarialRaces.test.ts`, **B1 preserves typing during note verdict download**
  and **B1 preserves typing during move verdict download**:
  the late replacement survives in exactly one complete conflict copy, not inside
  the original. Attachment/settings variants are unchanged. A new quota case
  verifies pending note bytes survive refusal and deliver after quota increases.
- `scenario/join.test.ts`:
  - **merge: every class ends as the table says, in one sync, and every loser is a version**:
    the divergent note is a complete copy; source history and exact manifest are
    asserted separately. Opaque losers still use history.
  - **a rescan by the engine that joined sends no preference: the note conflicts**;
  - **nor does a fresh engine given the same choice, once the cursor is above 0**:
    post-join colliding creates keep two files rather than concatenating text.
- `scenario/joinEnds.test.ts`:
  - **ends anyway: joinFinished says so, and a later race conflicts, not preferred**;
  - **a local file over the cap does not keep the server's file at that path held**:
    later competing creates assert the exact original and one copy; join ending
    and cap behavior remain unchanged.
- `scenario/overCapHead.test.ts`:
  - **a local delete does not delete the merged note (P1)**;
  - **a raised cap brings the merged note down (P2)**;
  - **a local edit does not replace the merged note cleanly (P5)**;
  - **a delete here that loses to the merged note drops the entry, and settles (Q2)**;
  - **settles: nothing is sent again, run after run**:
    their shared fixture now starts from a small common base and changes separate
    lines. This preserves every over-cap clean-merge/retained-version assertion
    without depending on forbidden baseless concatenation.
  - **a create keeps no entry, so its next edit deletes nothing of the head**:
    the two differently worded creates get separate complete copies; the over-cap
    original remains byte-for-byte unchanged.
  - **an edit of the joined copy keeps the seeder's lines (Q4)**:
    edit the actual new copy identity, keeping its single identity and the original
    bytes intact, rather than recreating a new note at the old original path.
- `scenario/pullWriteRecovery.test.ts`:
  - **does not adopt typing after a crashed pull, even when size and mtime match its planned write**;
  - **does not adopt an offline edit matching an intermediate version on an earlier feed page**:
    same-line stale changes become complete copies. All base/provenance/page-order
    assertions remain; both complete variants are explicitly checked.

## CLI compatibility

Only tests changed in CLI; its production code is unchanged.

- `e2e/joinPrefer.test.ts`, **--prefer merge: two complete files, and nothing kept in the config**:
  a competing create has one complete copy, not concatenation.
- `e2e/adversarialSigkill.test.ts`, **join merge at join-marker retains its preference after SIGKILL**
  and **join merge at commit-after retains its preference after SIGKILL**:
  restart preserves the original and exactly one complete local copy. Explicit
  mine/theirs cases keep their existing behavior.

## New server regressions

- `conflictDivergences.test.ts`: identical suppression, full bytes, device retries,
  distinct bases/create sentinel, source rename (including a colliding create's
  old submitted path), head advancement, opaque collisions, edited/deleted copies,
  receipt safety, normal payload GC, durable metadata and exact usage/refcounts.
- `scopedConflictDivergences.test.ts`: separate principals and independent PG
  pools, authorized grants, personal/scoped reuse, pre-admission-base refusal,
  hidden name collisions, fresh request IDs, receipt expiry, compact acknowledgements,
  edited/moved/deleted copies and revoked authority.
- `conflictProcess.test.ts`: independent SQLite processes with stale snapshots;
  real SIGKILL after copy rows but before commit and after commit; exactly one
  creation/receipt identity per landed branch and exact blob accounting.
- `conflictMigration.test.ts`: populated 010 upgrade, transactional DDL interruption
  and restart, no historical filename inference, unique identities, lifecycle
  survival and vault cascade, unsafe downgrade/schema refusal.
- `vaultLock.test.ts`: whole-transaction rollback/retry and bounded exhaustion.
- `backupIntegrity.test.ts`: rejects a snapshot whose 011 journal lacks its table.
