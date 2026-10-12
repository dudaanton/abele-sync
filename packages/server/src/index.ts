#!/usr/bin/env node
import type { FastifyInstance } from 'fastify'
import { buildApp } from './api/app.js'
import { BlobStore } from './blobs/store.js'
import { loadConfig } from './config.js'
import { createDb } from './db/connect.js'
import { runMigrations } from './db/migrate.js'
import { EventHub } from './events/hub.js'

/** Stage-1 public process: fresh schema and token management, no old sync compatibility.
 * Upload recovery/retention are rewired with the unified file API, not run against old grants. */
async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const handle = createDb(config.databaseUrl)
  let app: FastifyInstance | undefined
  try {
    await runMigrations(handle.db)
    app = await buildApp({
      config,
      db: handle.db,
      dialect: handle.dialect,
      store: new BlobStore(config.blobDir, config.masterKey),
      hub: new EventHub(),
    })
    await app.listen({ port: config.port, host: config.host })
    console.log(`abele-sync listening on http://${config.host}:${config.port}`)
    const listening = app
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      void listening
        .close()
        .then(() => handle.close())
        .catch((error) => {
          console.error('shutdown failed:', error)
          process.exitCode = 1
        })
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  } catch (error) {
    await app?.close().catch(() => undefined)
    await handle.close().catch(() => undefined)
    throw error
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
