import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: {
    alias: {
      '@abele/sync-protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/build.globalSetup.ts'],
    setupFiles: ['tests/helpers/fileDatabase.setup.ts'],
    testTimeout: 30_000,
  },
})
