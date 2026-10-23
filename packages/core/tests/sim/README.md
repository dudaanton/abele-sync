Tier A uses the production v2 `buildApp` and `V2EngineClient` through `fetchFor`.
No sockets, devices, real vaults or provider processes are involved. All server
storage lives in disposable `.scratch/sim-*` directories. No new dependency was
added (`fast-check` passed the dependency audit; generation/shrinking is local).

`pullPublication.test.ts` explores placement widths 1 and 3 in buffered,
bounded-source and staged modes. It restarts after every scheduled crash boundary;
concurrent cases additionally inject cancellation and failure at every boundary.
The same disk/ledger/cursor, installation reuse and stage cleanup oracles apply.
Cancellation also checks that no later applied callback is emitted.
Concurrent cases also exercise legacy transaction callbacks without a handle.
`recoveryDirectoryHold.test.ts` restarts with an exact move intent/private stage
and a source or destination directory hold, replays every recovery crash boundary,
then checks convergence after explicit hold resolution. It also checks direct
placement and recovery without a prepared client.

From the repository root, after installing the locked dependencies:

```sh
mkdir -p .scratch
TMPDIR="$PWD/.scratch" SIM_RUNS=200 node_modules/.bin/vitest run --config vitest.config.ts --root packages/core tests/sim --maxWorkers=2
```

H1, T1, T2 and the D-001/D-002 JSON cases are ordinary passing regressions after
the core reliability fixes. Halt traces expect the explicit `SyncCancelled`
result and still assert the original effect envelope and convergence oracles.

Replay one generated seed (25 actions by default):

```sh
TMPDIR="$PWD/.scratch" SIM_SEED=10 SIM_RUNS=1 node_modules/.bin/vitest run --config vitest.config.ts --root packages/core tests/sim/fuzz.test.ts --maxWorkers=2
```

Every JSON file in `regressions/` is replayed by the regression test loop. A `bug`
field selects `it.fails`; ordinary recovery traces must pass. New random failures
are reduced by chunk deletion, individual action deletion and empty-text
simplification, preserving the original error's first line. Set `SIM_SAVE=1` to
save the minimized trace. Review its failure before adding a `bug` marker.
`SIM_SHRINK_KNOWN=1` with `-t minimizes` re-minimizes the three directed JSON cases.

Studio long sweep (increase the timeout when increasing sequence length):

```sh
TMPDIR="$PWD/.scratch" SIM_SEED=1 SIM_RUNS=10000 SIM_ACTIONS=80 SIM_SAVE=1 SIM_TIMEOUT=7200000 node_modules/.bin/vitest run --config vitest.config.ts --root packages/core tests/sim/fuzz.test.ts --maxWorkers=2
```

The random test has a 90-second default; use `SIM_TIMEOUT=7200000` for long runs.
No long sweep is intended for the laptop.

Exhaustive first-upload push cuts (Studio):

```sh
TMPDIR="$PWD/.scratch" SIM_EXHAUSTIVE=1 SIM_FILES=2500 SIM_TIMEOUT=7200000 node_modules/.bin/vitest run --config vitest.config.ts --root packages/core tests/sim/exhaustive.test.ts --maxWorkers=2
```

This first records the baseline's named boundaries, then creates a fresh server
and disk for every cut from the first upload through the remainder of the pass.
Failures retain their cut name in the assertion. A single 2,500-file directed cut
can be selected with `SIM_CUT='net.after.POST./v2/commit#1'` and `-t T1` on
`directed.test.ts`. A cut name is `label#occurrence`; UUIDs in network labels are
normalized to encounter-order aliases. The exhaustive test is an ordinary
assertion when explicitly enabled; CI does not run this sweep.

The scheduler selects ready continuations with a seeded PRNG. Crash increments
the device scheduler's epoch; old FS/state/client/transport handles reject before
further effects. Restart creates new client/engine handles over the same durable
disk/state. Transactions publish an isolated image only at commit. Stage bytes
survive crashes, require seal/hash verification and compare the base before
atomic placement. The process does not call `stop()` before crashing. Global
core UUID/random/Date.now sites are scoped to the fixture; the engine and server
receive the virtual clock explicitly. Real deadline/watch timers are not
virtualized; tests drive `sync()` directly and do not call `start()`.

`pullEdits.test.ts` adds I2: for buffered/streaming updates, moves, eviction and
remote deletion, first collect every scheduled pull await, then replay once per
boundary with a same-stat local save injected there. Moves run separately for
saves at the source and at the destination. Metadata/state calls, host operation
boundaries, and points before/after client page/content/version awaits participate;
streamed source reads, validation and closure also have scheduler points. Coverage
assertions require both sides of the client awaits. The atomic filesystem port itself is
indivisible in the memory model; Node's quarantine/publication races have separate
host tests. Run the bounded CI property, without the optional exhaustive sweep:

```sh
TMPDIR="$PWD/.scratch" SIM_RUNS=200 node_modules/.bin/vitest run --config vitest.config.ts --root packages/core tests/sim/pullEdits.test.ts --maxWorkers=2
```

Oracles cover preservation of injected local bytes (I2), own-content GETs (I3), the four-lane post-mark effect envelope
(I4), disk/manifest content equality and two idle rounds (I5), zero stages at
quiescence (I6), journal/cursor/identity/version/disk consistency (I7), and duplicate
file/content version effects for first-upload traces (I11). Content transport
records byte totals by SHA for streaming `openVersion` requests. Delete holds
are explicitly confirmed only when the model records a local deletion/move.

`directoryTombstoneReplay.test.ts` explores every scheduled cut through directory
feed classification, cleanup and cursor persistence, for installed and incoming-only
directories. Restart must not stage their tombstone as a file; classification
survives completed physical cleanup and ends only after durable cursor consumption.

Limits of this slice: one engine plus a remote v2 writer per generated trace;
no host UI, notices, SQLite client state, real process SIGKILL, case-insensitive
disk, virtual deadline timers, scope/token/restore-generation mutations or
mid-range socket failures. Random actions currently cover write/append/delete,
file move, empty directories, sync/rescan, pause/resume/stop, graceful restart,
crash between actions, before-send loss, applied-response loss, 503 and remote
create. In-flight cuts use directed/exhaustive mode. Stage ownership is checked
at quiescence, not against a plugin journal; I7 does not yet independently prove
that every held remote change fences the cursor. I11's unique-content oracle is
restricted to scenarios without intentional content revisits. The full planned
action alphabet, multiple engine devices and plugin/scale tiers remain future
work. Keep fixtures within one Vitest test at a time because runtime shims are
process globals.
