Tier A uses the production v2 `buildApp` and `V2EngineClient` through `fetchFor`.
No sockets, devices, real vaults or provider processes are involved. All server
storage lives in disposable `.scratch/sim-*` directories. No new dependency was
added (`fast-check` passed the dependency audit; generation/shrinking is local).

From the repository root, after installing the locked dependencies:

```sh
mkdir -p .scratch
TMPDIR="$PWD/.scratch" SIM_RUNS=200 node_modules/.bin/vitest run --config vitest.config.ts --root packages/core tests/sim --maxWorkers=2
```

H1 and T2 are `it.fails` with BUG references. **T1 is also marked `it.fails` as
requested, but the applied-commit response cut currently passes its assertions.**
Vitest therefore reports an unexpected pass, and CI is intentionally red pending
the manager's decision about that marker. Do not interpret an arbitrary exception
inside a fails test as proof of the bug: the developer report records unwrapped
diagnostic failures. No product fix is included.

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
TMPDIR="$PWD/.scratch" SIM_SEED=1 SIM_RUNS=10000 SIM_ACTIONS=80 SIM_SAVE=1 node_modules/.bin/vitest run --config vitest.config.ts --root packages/core tests/sim/fuzz.test.ts --maxWorkers=2 --testTimeout=7200000
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
normalized to encounter-order aliases. The exhaustive test retains the requested
D-001 fails marker too; an all-passing sweep is an unexpected pass.

The scheduler selects ready continuations with a seeded PRNG. Crash increments
the device scheduler's epoch; old FS/state/client/transport handles reject before
further effects. Restart creates new client/engine handles over the same durable
disk/state. Transactions publish an isolated image only at commit. Stage bytes
survive crashes, require seal/hash verification and compare the base before
atomic placement. The process does not call `stop()` before crashing. Global
core UUID/random/Date.now sites are scoped to the fixture; the engine and server
receive the virtual clock explicitly. Real deadline/watch timers are not
virtualized; tests drive `sync()` directly and do not call `start()`.

Oracles cover own-content GETs (I3), the four-lane post-mark effect envelope
(I4), disk/manifest content equality and two idle rounds (I5), zero stages at
quiescence (I6), journal/cursor/identity/version/disk consistency (I7), and duplicate
file/content version effects for first-upload traces (I11). Content transport
records byte totals by SHA for streaming `openVersion` requests. Delete holds
are explicitly confirmed only when the model records a local deletion/move.

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
