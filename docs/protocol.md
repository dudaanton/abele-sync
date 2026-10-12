# Sync protocol

The public server uses the [unified v2 contract](protocol-v2.md), exported as
`V2*Schema` and inferred types from `@abele/sync-protocol`.

Current public routes include `/healthz`, `/capabilities`, `/v2/connection`,
`/v2/tokens` (issue/list/revoke), and the v2 manifest, changes, events, commit,
upload and scoped file-content routes. No login, account/device enrolment, vault
selection, invitation, sponsored publication or `/v1` compatibility API is
registered by the public app.

Retained engine operation schemas describe file/version/blob/history primitives.
The v2 commit boundary authenticates before idempotent replay, authorizes every
input and auxiliary output, and consumes only the committing token's upload
entitlement. History/restore endpoints remain later-stage work.

Markdown merges are line-based. Any divergent change on a shared line keeps the
first accepted head intact and creates one complete incoming conflict copy per
distinct branch (space, original file, submitted base, incoming SHA). Replays
reuse that copy only while its current content and visibility can be proved.
Unknown live-note bases produce complete copies, not empty-base merges. Binary
and Canvas edits use newer-wins with the older input in history. Offline edits
revive deleted files under the same stable identity. Merged content uses the
latest original input mtime; receipt/audit time is never its modification time.

The retained-engine test fixtures are not a deployed server or evidence of v2
file convergence. A missing v2 engine binding remains an explicit expected
failure in the numbered acceptance harness.
