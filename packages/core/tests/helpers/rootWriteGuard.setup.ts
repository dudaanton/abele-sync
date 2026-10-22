import { afterEach, beforeEach, expect } from 'vitest'
import { guardRootWrites, takeRootWriteViolations } from './rootWriteGuard.js'

beforeEach(async () => {
  // Wait until the test's hoisted mocks have been registered. Importing the host
  // modules in setup's top level would bypass filesystem/crash-injection mocks.
  const [core, host, node, sim] = await Promise.all([
    import('../../src/state.js'),
    import('@abele/sync-core'),
    import('@abele/sync-node'),
    import('../sim/durableState.js'),
  ])
  // Core fixtures use built hosts; node aliases use sources. Cover both identities.
  for (const store of [
    core.MemoryStateStore,
    host.MemoryStateStore,
    node.SqliteStateStore,
    sim.DurableStateStore,
  ])
    guardRootWrites(store.prototype)
})

afterEach(() => {
  expect(
    takeRootWriteViolations(),
    'captured-root state writes inside transaction callbacks'
  ).toEqual([])
})
