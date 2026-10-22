import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import nodeConfig from './packages/node/vitest.config.ts'

const recovery = 'tests/unit/groupCrashRecovery.test.ts'
const project = (name: string) => ({
  extends: `./packages/${name}/vitest.config.ts`,
  root: fileURLToPath(new URL(`./packages/${name}/`, import.meta.url)),
})

export default defineConfig({
  test: {
    projects: [
      {
        ...nodeConfig,
        root: project('node').root,
        test: {
          ...nodeConfig.test,
          name: '@abele/sync-node-crash-recovery',
          include: [recovery],
          sequence: { groupOrder: 0 },
        },
      },
      ...['cli', 'core', 'node', 'protocol', 'server'].map((name) => ({
        ...project(name),
        test: {
          name: name === 'cli' ? 'abele-sync' : `@abele/sync-${name}`,
          ...(name === 'node' ? { exclude: [recovery] } : {}),
          // Nested crash replay performs millions of native filesystem operations.
          // Concurrent acceptance fsyncs exhaust its per-test budget on APFS; run
          // it first, then retain normal worker parallelism for the other files.
          sequence: { groupOrder: 1 },
        },
      })),
    ],
  },
})
