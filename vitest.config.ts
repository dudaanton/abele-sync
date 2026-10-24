import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import coreConfig from './packages/core/vitest.config.ts'
import nodeConfig from './packages/node/vitest.config.ts'

const scale = ['tests/unit/directoryScale.test.ts', 'tests/unit/startupYield.test.ts']
const cancellation = 'tests/unit/startupCancellation.test.ts'
const recovery = 'tests/unit/groupCrashRecovery.test.ts'
const project = (name: string) => ({
  extends: `./packages/${name}/vitest.config.ts`,
  root: fileURLToPath(new URL(`./packages/${name}/`, import.meta.url)),
})

export default defineConfig({
  test: {
    projects: [
      {
        ...coreConfig,
        root: project('core').root,
        test: {
          ...coreConfig.test,
          name: '@abele/sync-core-scale',
          include: scale,
          fileParallelism: false,
          // A wall-clock heartbeat measures SDK blocking only when another
          // test worker cannot exhaust the shared CPU quota between its ticks.
          // Keep the latency/operation assertions unchanged; serialize the
          // measurement before native crash replay and ordinary host suites.
          sequence: { groupOrder: 0 },
        },
      },
      {
        ...coreConfig,
        root: project('core').root,
        test: {
          ...coreConfig.test,
          name: '@abele/sync-core-cancellation-scale',
          include: [cancellation],
          fileParallelism: false,
          // Repeated 33k cancellation fixtures must not add GC pressure to
          // the startup heartbeat measurements. Every case still runs.
          sequence: { groupOrder: 3 },
        },
      },
      {
        ...nodeConfig,
        root: project('node').root,
        test: {
          ...nodeConfig.test,
          name: '@abele/sync-node-crash-recovery',
          include: [recovery],
          sequence: { groupOrder: 1 },
        },
      },
      ...['cli', 'core', 'node', 'protocol', 'server'].map((name) => ({
        ...project(name),
        test: {
          name: name === 'cli' ? 'abele-sync' : `@abele/sync-${name}`,
          ...(name === 'node' ? { exclude: [recovery] } : {}),
          ...(name === 'core' ? { exclude: [...scale, cancellation] } : {}),
          // Nested crash replay performs millions of native filesystem operations.
          // Concurrent acceptance fsyncs exhaust its per-test budget on APFS; run
          // it first, then retain normal worker parallelism for the other files.
          sequence: { groupOrder: 2 },
        },
      })),
    ],
  },
})
