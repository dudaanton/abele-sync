import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@abele/sync-protocol',
        replacement: fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      },
      // Core's integration tests run against the real server, from its sources rather than its
      // build: the test app, and whatever of the server a scenario drives directly.
      {
        find: /^@abele\/sync-server\/(.*)\.js$/,
        replacement: `${fileURLToPath(new URL('../server/', import.meta.url))}$1.ts`,
      },
    ],
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000 },
})
