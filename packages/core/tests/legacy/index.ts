// Test-only transport for independent retained file-engine regressions.
// Production consumers import src/index.ts and use token connections.
export * from '../../src/index.js'
export { SyncClient, VaultClient, type Platform } from './client.js'
