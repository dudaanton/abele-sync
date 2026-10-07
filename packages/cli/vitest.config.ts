import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: {
    alias: {
      '@abele/sync-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@abele/sync-protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  // Forks, not threads: the daemon tests send this very process a signal and wait for the
  // handler `run` installed, which only means something when each file has a process to itself.
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: [
      fileURLToPath(new URL('../server/tests/helpers/build.globalSetup.ts', import.meta.url)),
    ],
    testTimeout: 20_000,
    pool: 'forks',
  },
})
