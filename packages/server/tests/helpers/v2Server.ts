import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { WebSocket } from 'ws'
import { buildApp } from '../../src/api/app.js'
import { BlobStore } from '../../src/blobs/store.js'
import { loadConfig } from '../../src/config.js'
import { createDb, type Dialect } from '../../src/db/connect.js'
import { runMigrations } from '../../src/db/migrate.js'
import { EventHub } from '../../src/events/hub.js'
import { PG_TEST_URL } from './tempDb.js'

/** Real TCP server with durable SQLite, separate blobs, and no account/device bootstrap. */
export async function v2Server(
  dialect: Dialect = 'sqlite',
  options: {
    configurationDirectories?: readonly string[]
    now?: () => Date
    trustProxy?: boolean
  } = {}
) {
  const scratch = resolve('.scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'v2-'))
  const sqliteUrl = `sqlite://${join(dir, 'server.db')}`
  const handle = dialect === 'pg' ? await isolatedPgDb() : createDb(sqliteUrl)
  const databaseUrl = 'url' in handle ? (handle.url as string) : sqliteUrl
  let active = handle
  try {
    await runMigrations(handle.db)
    const config = loadConfig({
      ABELE_MASTER_KEY: 'ab'.repeat(32),
      ABELE_TOKEN_PEPPER: 'synthetic-v2',
      ABELE_TRUST_PROXY: options.trustProxy ? 'true' : 'false',
      ABELE_BLOB_DIR: join(dir, 'blobs'),
      ...(options.configurationDirectories
        ? { ABELE_CONFIGURATION_DIRS: JSON.stringify(options.configurationDirectories) }
        : {}),
    })
    const store = new BlobStore(config.blobDir, config.masterKey)
    const hub = new EventHub()
    let app = await buildApp({
      config,
      db: handle.db,
      dialect,
      store,
      hub,
      ...(options.now ? { now: options.now } : {}),
    })
    let address = await app.listen({ port: 0, host: '127.0.0.1' })
    let closing: Promise<void> | undefined
    async function stopApp() {
      // Fastify's websocket preClose hook may finish before its sockets emit
      // close. Await those events explicitly so subscriptions/timers detach
      // before destroying the database used by the event routes.
      const socketsClosed = [...app.websocketServer.clients].map((socket) => {
        if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
        return new Promise<void>((resolve) => {
          socket.once('close', () => resolve())
          socket.terminate()
        })
      })
      const appClosed = app.close()
      // This disposable listener owns its HTTP sockets too. Incomplete/pooled
      // HTTP connections must not extend fixture teardown.
      app.server.closeAllConnections()
      await Promise.all([appClosed, ...socketsClosed])
    }
    return {
      get db() {
        return active.db
      },
      dialect,
      databaseUrl,
      dir,
      config,
      store,
      hub,
      get address() {
        return address
      },
      // Drain application hooks while retaining the database for durable-state assertions.
      stop: stopApp,
      async restart(beforeOpen?: () => Promise<void>) {
        const port = Number(new URL(address).port)
        await stopApp()
        // Close only the pool, not tempDb's schema cleanup; then reopen the same durable data.
        await active.db.destroy()
        await beforeOpen?.()
        active = createDb(databaseUrl)
        await runMigrations(active.db)
        app = await buildApp({
          config,
          db: active.db,
          dialect,
          store,
          hub,
          ...(options.now ? { now: options.now } : {}),
        })
        address = await app.listen({ port, host: '127.0.0.1' })
      },
      close() {
        closing ??= (async () => {
          try {
            await stopApp()
          } finally {
            try {
              await active.db.destroy()
            } finally {
              await handle.close()
              await rm(dir, { recursive: true, force: true })
            }
          }
        })()
        return closing
      },
    }
  } catch (error) {
    await handle.close()
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}
export type V2Server = Awaited<ReturnType<typeof v2Server>>

/** Acceptance servers own separate PostgreSQL databases, not schemas of the same database. */
async function isolatedPgDb() {
  if (!PG_TEST_URL) throw new Error('ABELE_TEST_PG_URL is required')
  const name = `abele_v2_${randomUUID().replaceAll('-', '')}`
  const admin = createDb(PG_TEST_URL)
  try {
    await sql.raw(`create database "${name}"`).execute(admin.db)
  } finally {
    await admin.close()
  }
  const url = new URL(PG_TEST_URL)
  url.pathname = `/${name}`
  const handle = createDb(url.toString())
  let closing: Promise<void> | undefined
  return {
    ...handle,
    url: url.toString(),
    close() {
      closing ??= (async () => {
        try {
          await handle.close()
        } finally {
          const cleanup = createDb(PG_TEST_URL)
          try {
            // pg-pool.end() can resolve before its clients' TCP close callbacks.
            // Plain DROP waits for those backends to disconnect; FORCE could
            // instead kill an ending client and emit an unhandled 57P01 error.
            // A genuinely leaked connection must fail cleanup, never be killed.
            await sql.raw(`drop database if exists "${name}"`).execute(cleanup.db)
          } finally {
            await cleanup.close()
          }
        }
      })()
      return closing
    },
  }
}
