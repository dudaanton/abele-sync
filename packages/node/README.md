# Node replicas

`@abele/sync-node` provides the Node filesystem, SQLite state, locking, recovery,
and composition used by the command line client. Requires Node 22 or later.
Licensed GPL-3.0-only; see LICENSE.

```ts
import { openNodeReplica } from '@abele/sync-node'

const replica = await openNodeReplica({ dir: './replica', key: encodedToken })
const engine = replica.buildEngine({ fallbackMs: 300_000, log: console.log })
try {
  await engine.sync()
} finally {
  await engine.stop()
  replica.close()
}
```

The key form validates the token connection, persists its local configuration in
`.abele-sync`, acquires the directory lock, and finishes recovery before returning.
It refuses a different stored connection or an unbound existing ledger. Opening
an existing connection does not fetch connection information until recovery or
sync needs it. `close()` closes the database and releases the owned lock; stop
engines first. Failures release the lock automatically.

Pass `stateDir: './replica-state'` to keep the database, credentials and recovery
bookkeeping outside the synced directory. Reopen with the same `dir` and
`stateDir` to resume the ledger. A state directory is bound to the canonical synced
directory and cannot be reused for another directory. Nested state directories
are refused, except for the default `<dir>/.abele-sync`.

The key form locks both the external state directory and the synced directory;
the latter has a transient `.abele-sync/lock` claim so different state directories
cannot open the same synced directory concurrently. It is removed on close.
Temporary installation files and stages stay under `<dir>/.abele-sync` because
atomic renames into the synced tree require the same filesystem. Scanning and
watching continue to skip that folder.

For applications that already own a lock, the synchronous form is
`openNodeReplica({ dir, stateDir?, config, held: lock.held, fetch?, WebSocket?, defer? })`.
`config` is a `NodeReplicaConfig` (also exported as `DaemonConfig` for existing
callers): `serverUrl`, encoded `deviceToken`, server `vaultId`/`deviceId`,
`deviceName`, `selective`, and optional `joinPrefer`. New configuration is written
only under a held lock; stored configuration must agree. Call
`await replica.recover()` before using the engine or mutating the replica. The
caller releases its own lock after stopping engines and closing the replica.
With external state, the caller must own both the ordinary directory lock and a
lock acquired with `acquireLock(dir, { stateDir })`, and supply a `held` function
that checks both claims.
Without `held`, this form opens an existing replica for inspection; filesystem
mutation is refused and recovery requires an owned lock.

Both forms accept injected `fetch`, `WebSocket`, and a generic `defer(path)`
policy. The key form also accepts `selective` for initial configuration and
`lockTiming`. The CLI supplies its plugin-code deferral policy explicitly.

The returned `NodeReplica` exposes `dir`, `cfg`, `disk`, settling `fs`, `state`,
`client`, `ignore`, `ignoreText`, `filter`, `fence`, `recovery`, `recover()`,
`buildEngine()` and `close()`. Engine hooks are `fallbackMs`, `log`, optional
`onSync`, `onFail`, and `stillHeld`. `prepareNodeReplica`, `recoverNodeReplica`,
`buildNodeEngine`, and `nodeReplicaClient` are also exported for hosts composing
these steps explicitly.

Lower-level exports include `NodeFileSystem` and its options, `NodeStages`,
filesystem durability/guard helpers, `SettlingFileSystem`, `anyOf`,
`SqliteStateStore`, `acquireLock` and lock identity helpers, `EffectFence`,
local safety/projection inspection helpers, configuration persistence helpers,
`CodeDraft`/`CodeGroupDisk` recovery support, and state/ignore path helpers.

**No automatic recovery at the adapter level:** `SqliteStateStore.open()` and
`new NodeFileSystem()` only open adapters. They do not acquire a lock, validate a
connection binding, replay journals, or activate a recovery barrier. Hosts using
them directly must supply their own ownership and recovery protocol. Prefer
`openNodeReplica` for the standard on-disk layout.
