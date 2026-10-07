#!/usr/bin/env node
import type { FastifyInstance } from 'fastify'
import { buildApp } from './api/app.js'
import { BlobStore } from './blobs/store.js'
import { createUploadManager } from './blobs/uploads.js'
import { loadConfig } from './config.js'
import { createDb } from './db/connect.js'
import { runMigrations } from './db/migrate.js'
import { EventHub } from './events/hub.js'
import { runRetention } from './history/retention.js'

/**
 * The server as a program: configuration from the environment, a migrated
 * database, the HTTP app listening, and retention on a timer.
 *
 * The timer is unreferenced, so the sweep is never the reason the process stays
 * up; SIGTERM and SIGINT stop the app and close the database, and once both are
 * done nothing is left holding the event loop and node exits on its own.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const handle = createDb(config.databaseUrl)
  let app: FastifyInstance | undefined

  try {
    await runMigrations(handle.db)
    const { db, dialect } = handle
    const store = new BlobStore(config.blobDir, config.masterKey)
    const uploads = createUploadManager({ config, db, store, dialect })
    await uploads.recoverCompletions()
    app = await buildApp({ config, db, dialect, store, hub: new EventHub() })

    await app.listen({ port: config.port, host: config.host })
    console.log(`abele-sync listening on http://${config.host}:${config.port}`)

    const sweep = setInterval(() => {
      void runRetention({
        db,
        dialect,
        store,
        uploads,
        idempotencyTtlMs: config.idempotencyTtlMs,
        now: () => new Date(),
      }).catch((error: unknown) => {
        console.error('retention failed:', error)
      })
    }, config.retentionIntervalMs)
    sweep.unref()

    const listening = app
    let stopping = false
    const stop = (signal: NodeJS.Signals): void => {
      // A second signal while the first is still being carried out changes nothing.
      if (stopping) return
      stopping = true
      console.log(`abele-sync stopping on ${signal}`)
      clearInterval(sweep)
      void listening
        .close()
        .then(() => handle.close())
        .catch((error: unknown) => {
          console.error('shutdown failed:', error)
          process.exitCode = 1
        })
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  } catch (error) {
    // Nothing is listening, so nothing may be left holding the database either.
    await app?.close().catch(() => undefined)
    await handle.close().catch(() => undefined)
    throw error
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  // Exit rather than fall off the end: a pool that outlived the failure would
  // keep a process alive with nothing listening on it.
  process.exit(1)
})
