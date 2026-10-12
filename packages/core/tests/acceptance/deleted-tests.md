# Removed superseded access tests

The token access model removes old scoped grants/admission/approval and upgrade behavior.
Independent engine regressions remain, including the bounded group YAML parser. These 85 files assert the replaced model.

Legacy-access subsets were also removed from `packages/server/tests/integration/adminCli.test.ts` (account/password/vault commands), `packages/server/tests/integration/externalVerify.test.ts` (reader membership, scoped capability/header/admission cases), and `packages/core/tests/integration/externalVerification.test.ts` (scoped reader setup/verification). Their independent storage/content-integrity assertions remain, with fresh or retained-engine fixtures as appropriate. No independent engine test file was deleted.

Deleted files and reasons:

- `packages/server/tests/unit/upgradeEvidence.test.ts` — Removed unused upgrade-window attestations; no deployed data or conversion exists.

- `packages/core/tests/integration/scopedPush.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/core/tests/unit/scopedConnection.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/core/tests/unit/scopedPull.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/core/tests/unit/scopedSettlementCollision.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/core/tests/unit/scopedUploadTransport.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/protocol/tests/scopedCommits.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/protocol/tests/scopedV4.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/protocol/tests/targetVisibility.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/activeGrantRenewal.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/api.scopedFences.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/api.scopedSharing.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/crossGrantV4.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/folderAdmissions.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/folderManagement.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/folderManagementRace.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/folderPreparationPaging.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/grantPreparationResponse.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupApproval.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupBindings.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupBootstrap.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupBootstrapFailure.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupDirty.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupGrantList.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupLifecycleRecovery.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupManagement.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupMembershipRace.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupNativeIntegrity.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupOriginPersistence.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupOriginRisks.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupSourceAuthority.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupUnavailableRecovery.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupUnicodePaths.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupViews.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupWorker.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/groupWrites.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/liveScopedBoundaries.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/liveScopedRevocation.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/migrate008.test.ts` — Old access-schema upgrade/rehearsal; no deployed sync data or conversion is supported.
- `packages/server/tests/integration/migrate009.test.ts` — Old access-schema upgrade/rehearsal; no deployed sync data or conversion is supported.
- `packages/server/tests/integration/migrate010.test.ts` — Old access-schema upgrade/rehearsal; no deployed sync data or conversion is supported.
- `packages/server/tests/integration/migrate010LegacyFacts.test.ts` — Old access-schema upgrade/rehearsal; no deployed sync data or conversion is supported.
- `packages/server/tests/integration/scopedCleanup.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedCommitRace.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedContent.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedContentPrivacy.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedCreateMove.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedExpiryBoundary.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedFeed.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedFeedPrivacy.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedGc.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedHistory.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedLeaseBounds.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedLifecycle.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedMergeInputs.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedMergeOutputs.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedMigrationAtomic.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedMultipart.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedPublicationOrigins.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedReadBoundaries.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedReceipts.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedResourceBounds.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedSchemaShape.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedSelfRevoke.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedSnapshotRace.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedSnapshots.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedState.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedUpload.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/scopedUploadRace.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/sponsoredAssets.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/targetVisibility.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/upgradePreflight.test.ts` — Old access-schema upgrade/rehearsal; no deployed sync data or conversion is supported.
- `packages/server/tests/unit/folderSecurity.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/unit/groupAnchors.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/unit/groupOrigins.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/unit/scopedFence.test.ts` — Superseded scoped grant/invitation/admission/approval/publication API, not token access.
- `packages/server/tests/integration/agentRevocation.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.
- `packages/server/tests/integration/routeSecurityMatrix.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.
- `packages/server/tests/unit/upgradeInspection.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.
- `packages/server/tests/integration/api.auth.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.
- `packages/server/tests/integration/api.devices.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.
- `packages/server/tests/integration/api.settingsAuth.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.
- `packages/server/tests/integration/api.vaultDevices.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.
- `packages/server/tests/integration/api.vaults.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.
- `packages/server/tests/integration/auth.test.ts` — Superseded account/device/scoped-facet ownership or unused upgrade inspection; replaced by v2 token authority/fresh-bootstrap tests.

## Stage 2 — removal of the legacy writer access implementation

- `packages/server/tests/integration/incompleteSnapshotFeed.test.ts` — legacy grant bootstrap/snapshot preparation; replaced by durable fixed-cursor token snapshots.
- `packages/server/tests/integration/restoredFeedKnowledge.test.ts` — old grant knowledge/feed generations and admission restoration no longer exist; v2 feeds use version-time visibility.
- `packages/server/tests/integration/multipartPendingBudget.test.ts` — separate scoped reservations/expiry were deleted; token uploads share the retained pending table and quota machinery.
- `packages/server/tests/integration/modifyBatchOwnership.test.ts` — legacy scoped write certificates/native ownership; v2 authorizes every output under one token boundary.
- `packages/server/tests/integration/ownerDevicePublicationRace.test.ts` — owner-device publication/sponsor workflow removed; group publication is rebuilt in stage 3.
- `packages/server/tests/integration/externalVerifyRaces.test.ts` — account/device/folder-grant authority race matrix was removed with those authorities; unified external verification remains stage 4 (not claimed verified here).
- `packages/server/tests/integration/nativeAssetContract.test.ts` — intrinsic/native sponsor contracts removed; folder writes no longer depend on authorship.
- `packages/server/tests/integration/deletedAccessGround.test.ts` — legacy admission/security grounds after group deletion; stable selectors and unavailable-state events replace them.
- `packages/server/tests/integration/nativeApiBudget.test.ts` — resource budget of the deleted native sponsor API, not a current engine quota test.
- `packages/server/tests/integration/preparationHeadProof.test.ts` — folder preparation proof/certificate state deleted; visibility now lands atomically with engine operations.
- `packages/server/tests/integration/repairMergeLineage.test.ts` — legacy security-fact reproof across merge lineage removed; ordinary merge/history regressions are retained.
- `packages/server/tests/integration/sponsorProof.test.ts` — intrinsic/native sponsor proof machinery deleted; knowing a SHA never grants token visibility.
- `packages/server/tests/integration/versionSecurity.test.ts` — version_security_sources/admission eligibility removed; version-time scope authorization replaces this legacy authority model.
- `packages/server/tests/integration/preparationConflictBirth.test.ts` — admission-preparation classification of conflict births deleted; unified commit boundary records auxiliary output visibility.
- `packages/server/tests/integration/multipartQuotaCompletion.test.ts` — separate scoped multipart reservations/completion deleted; retained engine quota/completion regressions and v2 ownership tests remain.
- `packages/cli/tests/unit/scopedFeedCollisionSafety.test.ts` — old scoped feed/admission settlement, replaced by the unified adapter in subsequent client work.
- `packages/cli/tests/unit/scopedSettlementSafety.test.ts` — old scoped write receipts/settlement removed; general engine recovery/journal tests remain.
- `packages/cli/tests/unit/personalDurableSettlement.test.ts` — durable owner-publication settlement/sponsor request adapter deleted; ordinary journal/restart/unsent-byte regressions remain, unified publication needs later client evidence.
- `packages/core/tests/integration/personalNoteEvents.test.ts` — owner-personal/scoped publication event distinction removed; incoming writes are ordinary changes under the unified model.
- `packages/server/tests/unit/hash.test.ts` — password/login-token hashing tests belonged to the deleted account auth; v2 tests cover random bearer keys and stored HMAC digests.

Retained/ported partial files (not deleted):

- `packages/server/tests/integration/configRegistryMaximum.test.ts`: keeps maximum-registry/commit assertions and now verifies root/partial boundaries against the actual v2 server. Only legacy security-fact assertions were replaced.
- `packages/server/tests/integration/modifyBaseProvenance.test.ts`: keeps independent binary version/previous-head assertions; removes only version_security_sources assertions.
- `packages/server/tests/unit/config.test.ts`: removes only the old scoped feature-flag test along with that flag; other configuration validation stays.

## Stage 3 integration — cherry-picked server merge

- `packages/server/tests/integration/scopedConflictDivergences.test.ts` — deleted with the old grant/admission/certificate writers; token conflict and replay tests replace that access matrix.
- Kept deleted during cherry-pick: `scopedMergeOutputs.test.ts`, `groupUnavailableRecovery.test.ts`, `migrate009.test.ts` (reasons already listed above). No legacy production access code was restored.
- `originalMtime.test.ts` was ported to real v2 root/folder requests, retaining both time orders, combined/exact-incoming merges, input history, and complete-copy mtime assertions.
- `deleteEditWins.test.ts` was ported to v2 root/folder requests: file identity revival, pruned base, binary/Canvas/note edits, unauthorized/private/unknown base, departed scope, revocation, upload retention, dedup versus deletion, and occupied near-limit placement remain. Old group sponsor/protected-frontmatter and three separate legacy writer entrypoint assertions were removed: those mechanisms no longer exist. Group revival under the new graph remains unverified until stage 3.
- `conflictMigration.test.ts` now checks fresh token schema, interrupted DDL, restart, uniqueness, lineage independent of payload GC, space-delete cascade, downgrade refusal and missing-table refusal. Old-account populated-schema upgrade is not supported.

The legacy regression **transport scaffolding**, not a production compatibility implementation, was moved to `packages/server/tests/legacy/`. Independent engine, history, range/upload, crash and journal tests continue to run.

## S4 — core token transport cleanup

- `packages/core/tests/integration/personalOwnerHooks.test.ts` — owner preflight holds/sponsor settlement are removed, not part of token publication.
- `packages/core/tests/integration/personalSettlementSourceSafety.test.ts` — owner-hook settlement callback integrity is superseded; ordinary journal, upload integrity, pull-write and staging regressions remain.
- `packages/core/tests/unit/externalVerification.test.ts` was ported to v2 token requests, retaining malformed-capability, integrity mismatch, size ceiling, proxy refusal and offline checks. The duplicate legacy personal/scoped-facet matrix was removed.
- The old HTTP regression client moved to `packages/core/tests/legacy/`. Only retained independent engine regressions import it; the production core exports neither legacy client nor scoped adapters/publication hooks.

## S4 — initial CLI token port (legacy fixture port still unfinished)

- `packages/cli/tests/unit/agent.test.ts` — old machine-key/grant setup, self-revoke and separate agent command namespace were deleted; token connections use the same CLI commands.
- `packages/cli/tests/unit/agentNativeScan.test.ts` — native scoped grant/sponsor admission scanning was deleted; token group eligibility is not implemented yet.
- `packages/cli/tests/unit/externalAgentSafety.test.ts` — separate scoped agent ledger/lifecycle adapter was deleted. General SQLite external-state, materialization and recovery tests remain and need their token fixtures ported.
- `packages/cli/tests/unit/externalDowngrade.test.ts` — pinned old account-client downgrade/force-init compatibility is not supported by the token access model; its `fixtures/config-v1/` implementation was removed too.
- `packages/cli/tests/unit/connectionSwitch.test.ts` — old force-init credential replacement/revocation and account-vault switching were removed. New connect refuses a different credential over a retained ledger; token HTTP tests verify that refusal preserves files.
- `packages/cli/tests/unit/externalState.test.ts`: only the removed scoped checkpoint case was ported to atomic token feed-cursor/external-work persistence; other state assertions remain.

The initial CLI port left fake-server/account fixtures and e2e bootstrap referencing removed commands. The continuation below ports those regressions; server history/restore remains a dependency, not grounds to delete those assertions.

## S4 continuation — CLI fixture ports

- `packages/cli/tests/e2e/joinNotNeeded.test.ts` — deleted: all assertions concern the removed `init --prefer` option and its not-needed diagnostics. Empty/fresh connections and same-token reconnection assertions are retained in `joinReconnect.test.ts`.
- `packages/cli/tests/e2e/replace.test.ts` — deleted: force-init account/device credential replacement, best-effort old-device revocation and revocation timeouts no longer exist. Its independent address-normalization assertion is ported to an encoded token in `init.test.ts`; replacement refusal with files/ledger intact is covered in `vaultIdentity`, `joinReconnect` and `tokenConnection`.
- `packages/cli/tests/unit/cli.test.ts` — removed account login/enrolment, password prompt/environment, directory-named vault creation/selection and force-init ledger-reset assertions, including old credential-marker inheritance. Token connect instead validates one bearer, persists private config, never replaces a live connection and refuses foreign ledgers. The old server usage-display assertion is removed because v2 connection status provides limits, not the legacy usage endpoint. Retained command parsing, run, rescan, daemon scope retry/signals, status/cap, history/diff, restore beside a daemon, temp preservation, summary/refusals, authorization and sanitization assertions are ported to v2 mocks; some pairs are combined into single tests.
- `packages/cli/tests/e2e/init.test.ts` — removed account/device enrolment and force-init revocation/replacement lifecycle; token environment, refusal and safe-address assertions are ported. Real token revocation and preservation of unsent files remain in `tokenConnection.test.ts`.
- `packages/cli/tests/e2e/join.test.ts`, `joinPrefer.test.ts` — removed interactive join-choice/force-choice retention and server/local preference branches, superseded by scenario 39's single server-original plus local-conflict rule. The independent first-connect complete-copy, binary newer-wins, unique-file and idle convergence assertions remain over token connections.
- `packages/cli/tests/e2e/adversarialSigkill.test.ts` — removed only B15's force-init config-switch cut and corresponding child hook. Switching a retained ledger is now refused rather than resetting state; `vaultIdentity` and `joinReconnect` check the preserved cursor/config/bytes. Every ordinary scan/upload/commit/pull/merge/delete/join-marker SIGKILL regression remains.
- `packages/cli/tests/e2e/disconnect.test.ts` — old disconnect-implies-revoke, offline force-forget and server-revoke-timeout branches are removed: disconnect is local and does not revoke. File/ledger preservation, still-active bearer, no-network disconnect and lock refusal remain.
- `packages/cli/tests/unit/externalActivation.test.ts` — removed only assertions against the deleted pinned v1 config reader. Preparing/active descriptors, physical SQLite identity, definite/unknown COMMIT and recovery holds remain.
- `packages/cli/tests/unit/externalSafety.test.ts` — removed only owner-publication-held metadata branch. The removed scoped-outbox fixture is replaced by current orphan disconnect-staging evidence; generic staging preservation/recovery assertions remain.
- `packages/cli/tests/unit/externalMaterialization.test.ts` — force enrollment/login ordering is replaced by refusal of a replacement token without network/materialization effects. Same-token reconnect after disconnect, all materialization/reopen cut points, no-clobber, ENOSPC, local edits, Unicode paths, digest/size, physical-ledger and projection holds remain.

## Independent review of S4 (seven reproductions)

No pre-existing test was deleted or skipped. The unsafe clean-merge expectation
for a replacement with an adjoining insertion now expects a complete conflict
copy, as recorded in `packages/server/tests/lineMergeExpectations.md`. Retained
`engine.test.ts`/`pusher.test.ts` late-typing fixtures add an unchanged anchor so
all watcher, journal, byte-preservation, settlement and clean-merge assertions
continue to run on provable independent edits. The over-cap stale-base fixture's
second edit is behind an unchanged line instead of relying on an ambiguous
partial overlap; all cap/baseline/remote-byte assertions remain. The retained
file-only engine fixtures now have an empty explicit-directory catalog so shared
engine path checks run without a production compatibility fallback.

New `v2ReviewAccess.test.ts`, `v2ReviewMerge.test.ts`, real group WebSocket tests
and seeded insertion/replacement properties capture every review reproduction.

## S4 continuation — v2 history and groups

No test file or independent assertion was deleted in this continuation. The temporary
`scope_updating` expectation in `v2Tokens.test.ts` is now `active`, because group
membership is implemented. The bounded YAML parser regressions remain intact and
import the shared portable protocol parser; its unused server-only forwarding module
was removed. New history, group privacy/graph/publication, numbered server facets,
and two-server/three-device group convergence tests were added.

`deleteEditWins.test.ts` still verifies live tombstone reads are refused, identity
revival, base-payload GC, private/departed/revoked bases, upload retention and all
note/Canvas/binary outcomes. Its old assertion that _explicit authorized historical
bytes_ must also be unreadable while in trash is replaced by the v2 history
contract: visible retained versions can be reviewed; pruned or earlier-private
versions cannot. No convergence assertion was removed.

`packages/core/tests/integration/externalVerification.test.ts` now uses the actual
v2 server and `V2EngineClient` rather than the legacy test server. Live-head,
authenticated content, exact verification and deleted-file refusals remain; v2
server tests add partial/group visibility, corruption, ceilings and authority races.

All shared e2e bootstrap now launches the production v2 server and provisions named synthetic spaces via `user create`; each connection receives an independent issued token. No compatibility client or skipped history regression was introduced. V2 history/trash/restore and external verification now have production server endpoints and scope-visibility tests. Groups, explicit publication, and their numbered server facets run against those same endpoints; live Mac/iPhone evidence remains separate.
