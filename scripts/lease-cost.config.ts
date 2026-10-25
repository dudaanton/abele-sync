import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/lease-cost.bench.ts'],
    setupFiles: ['packages/server/tests/helpers/fileDatabase.setup.ts'],
    testTimeout: 1800000,
    fileParallelism: false,
  },
})
