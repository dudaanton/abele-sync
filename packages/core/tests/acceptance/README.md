# Numbered acceptance harness

`manifest.json` contains scenarios 1–124 verbatim, driver, assertions and required
platform evidence. A hash test protects the Russian text. `manifest.ts` keeps
server automation separate from live Mac and physical iPhone evidence. No live
hardware evidence has been recorded here.

`scenarios.test.ts` registers every number. Green **server facets** are:

- Stage 1: **1, 4, 7, 9, 11, 16–21**.
- Stage 2: **5–6, 12–13, 15, 22–40, 42–56, 69–73, 108–110** (folder/root
  variants).
- Groups: **14, 41, 57–68, 74–82** (server/core facets; consent UI is not live evidence).
- External files: **111–116** (authorized verification/download/forwarding facets;
  host eviction/hydration and platform UI remain separate).
- Conflicts: **91–100**, including **97–99**, run production V2 engines through
  two servers and three devices: disjoint/identical/overlapping edits, one copy
  per divergence, repeated devices/lost responses, forwarding an existing copy,
  both group memberships and outsider denial, restart and idle version counts.
  The bridge completes its round trip before other devices forward stale branches.
  Independent simultaneous conflict resolutions with different first-arrival
  winners on both servers are not a globally ordered resolution guarantee.
- Remaining core guarantees: **2–3, 8, 10, 83–90, 101–107**. Token/decoded-QR
  payloads, durable restart, settings/script staging and version-bound review,
  offline catch-up, independent server progress, interrupted journals, per-file
  refusals, quota/storage recovery and multi-page convergence use real V2 HTTP
  and production engines. QR camera, Obsidian reload/dialogs and physical phone
  behavior still require plugin/platform evidence.

There are **116 green server/core facets and eight retained `it.fails` per
dialect**, numbered **117–124**. No numbered placeholder was deleted or skipped.

## Audit of the original expected failures

Every formerly pending number is listed below. **(a)** means a missing
server/core test, now implemented; **(b)** means a plugin/client/platform check
that must be verified in the plugin, not a server guarantee. No plugin or live
hardware evidence was inspected or recorded in this repository. Mixed scenarios
have a green core facet and retain their manifest's live evidence obligations.

| Number | Classification and verification                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2      | (a) Paste one encoded token, resolve its server/scope, fetch exact bytes.                                                                                          |
| 3      | (a) Decoded QR payload uses the same token connection and bytes; camera scanning is (b), plugin-owned.                                                             |
| 8      | (a) Offline paste preserves connections, reports `offline`, then reconnects and downloads.                                                                         |
| 10     | (a) Durable token/state restart and bidirectional sync; Obsidian lifecycle is (b).                                                                                 |
| 83     | (a) Root uploads settings/scripts to both servers and stages received settings/code.                                                                               |
| 84     | (a) Folder/group tokens exclude root settings; a shared-folder script is staged.                                                                                   |
| 85     | (a) New code is absent from the active filesystem until review; exact bytes, connection and observation time are available.                                        |
| 86     | (a) Every subsequent code version, rename and deletion requires a new version-bound decision.                                                                      |
| 87     | (a) Apply exactly the reviewed version's bytes.                                                                                                                    |
| 88     | (a) Rejection retains active local bytes and ordinary file exchange continues.                                                                                     |
| 89     | (a) Approval of an old version cannot apply a superseding candidate.                                                                                               |
| 90     | (a) Other-server candidates and review metadata survive durable device restart.                                                                                    |
| 91     | (a) Cross-server nonoverlapping lines merge, with no conflict copy.                                                                                                |
| 92     | (a) Overlapping lines retain original and one copy with exact unsliced variants.                                                                                   |
| 93     | (a) Identical edits converge without a conflict copy.                                                                                                              |
| 94     | (a) Multiple overlapping lines produce one whole-note copy.                                                                                                        |
| 95     | (a) Three devices delivering the same divergence do not add copies.                                                                                                |
| 96     | (a) Lost conflict response, durable journal replay and restart do not add copies.                                                                                  |
| 97     | (a) A competing edit enters via server 2, resolves on server 1 and is forwarded back.                                                                              |
| 98     | (a) A copy already created on server 1 travels to server 2 and three devices with the same path/bytes, without extra copies. Server IDs remain server-local.       |
| 99     | (a) Both variants retain both groups; each scoped group can download them, an unrelated group cannot list or download them.                                        |
| 100    | (a) Idle rounds and restart preserve bytes, versions, divergences and uploads.                                                                                     |
| 101    | (a) Offline local edits and remote edits catch up with ordinary line merge.                                                                                        |
| 102    | (a) A disconnected server leaves edits local while the second server/device progresses; reconnection converges.                                                    |
| 103    | (a) Lost directory/file commit responses and server/device restart replay durable journals without duplicate versions.                                             |
| 104    | (a) A refused file has its path/code/message and pending count; other downloads/uploads and connections continue. UI display is (b).                               |
| 105    | (a) Quota refusal and injected `ENOSPC` at real HTTP blob storage retain bytes/journal/pending state; removing the fault resumes transfer. No host disk is filled. |
| 106    | (a) Oversized V2 local files produce `too_large` and pending work; raising the cap succeeds. User-selected exclusions remain exclusions.                           |
| 107    | (a) 1,005 files cross commit batches and manifest pages through both servers/three devices, reach idle and stop writing. This is not a vault-scale benchmark.      |
| 117    | (b) Physical iPhone token entry and camera QR scan. Retained `it.fails`.                                                                                           |
| 118    | (b) Physical iPhone Obsidian filesystem/watch CRUD and return delivery. Retained `it.fails`.                                                                       |
| 119    | (b) iOS suspension/foreground plugin lifecycle. Retained `it.fails`.                                                                                               |
| 120    | (b) Native iOS transport during Wi-Fi/cellular loss and handover. Retained `it.fails`.                                                                             |
| 121    | (b) iPhone note-open attachment consent dialog with conscious allow/deny. Retained `it.fails`.                                                                     |
| 122    | (b) iPhone review UI displays source/time/exact code and accepts a decision. Retained `it.fails`.                                                                  |
| 123    | (b) iPhone UI locates both conflict variants and shows refused file/reason. Retained `it.fails`.                                                                   |
| 124    | (b) iPhone simultaneous plugin coordination and native-transport outage isolation. Retained `it.fails`.                                                            |

`serverRemaining.ts` and `serverConflicts.ts` are also called by standalone
`remainingV2.test.ts` and `conflictsV2.test.ts`, so broken guarantees fail ordinary
tests rather than becoming accepted expected failures. V2 reports server size
limits as upload refusals; portable clients that omit `reportSizeRefusals` retain
their existing exclusion behavior. A manifest candidate's `at` is its local
observation time, not a claim about author identity or server commit time;
authored file `mtime` is unchanged. Review UI receives the source connection
from its binding, not from the manifest's synthetic actor.

The label explicitly says `server facet; live evidence pending`. A green server
facet is **not** completed production-client coordination, UI, file placement or
phone evidence. `serverStage2.ts` uses real HTTP to compare actual bytes, paths,
identities, scope events, rejected requests and idle version counts. It exercises
cross-server forwarding, overlapping access, a delayed response, directory
identity and unavailable selectors. Direct server facets remain distinct from
production-device tests.

Fixtures own two real HTTP listeners with separate durable databases/blob stores
and three devices with independent real filesystems and durable SQLite state.
PostgreSQL servers use distinct databases. Each device owns a production
`SyncEngine` per connection, with an injectable client factory. Its default is
now the production `V2EngineClient`; no token-to-account/device translation is
performed. `engineV2.test.ts` proves three-device/two-server file forwarding,
restart and idle quiescence. `directoriesV2.test.ts` adds empty folders, rename
identities, descendant moves and deletion. `removalV2.test.ts` covers partial
placement, departure/re-entry, revocation preservation and lost file/directory
commit responses across restart. `stopV2.test.ts` drains scoped page filesystem
effects before ledger shutdown. `groupsV2.test.ts` adds nested group eligibility,
foreign link retention, group-root rename/restart, scoped departure/re-entry and
unavailable-root preservation through two servers and three devices. Simultaneous
live-host coordination and platform UI remain separate verification. See the separately
committed [core API reference](../../../../docs/core-v2-engine.md).

Server integration tests additionally verify durable snapshot paging/restart,
version-time content privacy, idempotency, authenticated WebSocket notifications,
revocation/unavailable-state frames, multipart ownership and byte ranges. Group
sync uses indexed edges and cached selectors, including nested cycles, stable root
IDs, inherited boundaries and explicit connection-bound attachment publication.
History/trash/restore filters version-time visibility and forbids earlier-private
versions. External verification uses the actual live head, authenticated blob
SHA/length, retained references and final authority checks, never a guessed digest.

All remaining numbered scenarios are `it.fails`, never silently skipped.
`characterization.test.ts` now passes the decided offline policies after the
server-merge cherry-pick: edit beats delete; original mtime survives transport;
stale edits merge normally; merged mtime is the latest original edit, never
server now. The Russian text/hash was rechecked against the current binding
`scenarios-note.md`: the refreshed 1–124 text is protected by hash
`c46dbe670df29e93f6bbe497536734c887919b03441dc98d7490074beba0b861`.
The manifest now includes the final 108–110 decisions and the refreshed descendant
revocation scenario 21. The same driver also retains the own-device-token
independence assertion from the new 21a line. Revoking an issuer leaves its issued
descendants valid; this is an ordinary passing test, not a product question.

Available host ports identify note opening, attachment consent, script review and
hydration. Their live drivers and full upload interruption/quota/scale/retry
matrix remain later-stage work; the synthetic device convergence tests above do
not substitute for live Mac/iPhone evidence.

Independent engine regressions use test-only transports/catalogs/processes under
`packages/server/tests/helpers/retained*` and `packages/server/tests/legacy/`.
There is no production import of those adapters and no public compatibility API.
Production legacy server access source, schemas and migrations have been removed,
including both writer-import shims and the scopedWriter bridge. Token-owned upload
consumption and visibility replace them. Production core/CLI no longer export or
use the legacy clients, scoped adapters or owner-publication hooks. The independent
bounded group parser is shared by server indexing and local core eligibility;
its existing regressions are retained.

Run `npm test -- --maxWorkers=2`. The disposable PostgreSQL matrix is:

```sh
npm run test:sql:disposable -- packages/server/tests/integration packages/core/tests/acceptance
```

Deleted tests and individual reasons are listed in `deleted-tests.md`.
