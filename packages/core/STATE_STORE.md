# Transaction-scoped state

`StateStore.transaction` passes a private `StateStore` capability to its callback:

```ts
await transact(state, async (tx) => {
  const entry = await tx.byFileId(fileId)
  await recordResult(tx, entry)
  await tx.setJournal(null)
})
```

Use `tx` for **every** state read and write in the callback, including helpers,
other callbacks and nested transactions. Never capture the root store there.
`ResumeOptions.onCommitted(ops, tx)` follows the same rule. Do not retain a handle
after its callback settles. Nested transactions use `tx.transaction`, not the root.

A scoped adapter sets `transactionScoped = true` and provides a distinct handle.
Tentative writes are private, reads through the handle see its own writes, and
the patch becomes visible atomically on successful publication. A throw discards
only that patch. A write through the root belongs to an unrelated task: it must
complete independently and survive rollback, even when it updates the same key.
Expired handles must refuse further operations. Metadata, file-id indexes,
entries, cursor and journal all follow these rules.

Memory and SQLite buffer a patch proportional to the work done, without copying
the inventory. They use read-committed reads and conservatively refuse publication
with `EngineError('conflict', ...)` if any root write intervened. Callers retry;
they must not automatically replay a callback containing filesystem effects.
SQLite also checks `data_version` under its writer reservation, publishes without
an await inside the SQL transaction, and retains its unique file-id/wire-path
semantics in scoped reads. Data-only external phase commits remain forbidden
while a ledger callback is open; they cannot join its patch or publish a receipt
for an uncommitted group. Nested scoped handles have independent rollback.

`StateTransaction` is available to adapters as an overlay implementation. The host
must atomically validate its root revision and publish `mutations`; closing the
capability alone does not make a patch durable. Hosts with unique entries must
provide its indexed clash lookup. The IndexedDB adapter can collect the patch
across awaits, then check its revision and apply the patch in **one** short native
readwrite transaction, resolving only on `oncomplete`. Abort must not undo any
unrelated root transaction. No shared “current overlay” field may redirect root
calls into the suspended callback.

For existing hosts, core calls the exported `transact` compatibility helper.
An adapter which neither advertises scoped support nor passes a handle gets a
forwarding legacy capability, with engine transactions serialized per store.
Nested work stays inside the enclosing legacy transaction. This path requires
the host to reserve **exclusive root-store access for the whole callback**; it
cannot isolate direct writes by another host task. A host that cannot provide
that exclusion must implement scoped support before enabling concurrent use.
Advertising scoped support without supplying a distinct handle fails closed.
Existing callbacks which ignore their argument remain source-compatible, but
must be converted if they perform state effects.

The shared adapter contract in `tests/helpers/stateTransactionContract.ts` opens
a transaction, suspends it, writes through the root from another task, and then
rolls back. Both adapters run it, including same-key writes, entries/indexes,
metadata, cursor and journal. Host ports should run this contract too.

Core and Node tests also enable `tests/helpers/rootWriteGuard.setup.ts`. Its
Node-only async-context guard detects root writes (including helper/hook writes
after awaits) originating in a scoped callback. Unrelated callers can still
write independently. An after-test check retains violations even if a callback
swallows the thrown error. Ports are instrumented in `beforeEach`, after hoisted
filesystem mocks have been registered, so crash-injection tests keep their hooks.

Receipt hooks run inside the transaction: use `onCommitted(ops, tx)` and pass
`tx` into stateful helpers, for example `holds.tally(now, count, window, tx)`.
`onApplied` runs after ledger publication and `onDefer` runs before/outside the
ledger transaction; passing a closed handle into these hooks would be wrong.
Diagnostic logging and hash/filter/defer predicates must not mutate the ledger
from a transaction callback; the test guard detects such captured-root writes.
