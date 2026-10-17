import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@abele/sync-node',
        replacement: fileURLToPath(new URL('../node/src/index.ts', import.meta.url)),
      },
      {
        find: '@abele/sync-core',
        replacement: fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      },
      {
        find: '@abele/sync-protocol',
        replacement: fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      },
      {
        find: /^@abele\/sync-server\/(.*)\.js$/,
        replacement: `${fileURLToPath(new URL('../server/', import.meta.url))}$1.ts`,
      },
    ],
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
