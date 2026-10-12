import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
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
  options: { configurationDirectories?: readonly string[] } = {}
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
      ABELE_BLOB_DIR: join(dir, 'blobs'),
      ...(options.configurationDirectories
        ? { ABELE_CONFIGURATION_DIRS: JSON.stringify(options.configurationDirectories) }
        : {}),
    })
    const store = new BlobStore(config.blobDir, config.masterKey)
    const hub = new EventHub()
    let app = await buildApp({ config, db: handle.db, dialect, store, hub })
    let address = await app.listen({ port: 0, host: '127.0.0.1' })
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
      async restart() {
        const port = Number(new URL(address).port)
        await app.close()
        // Close only the pool, not tempDb's schema cleanup; then reopen the same durable data.
        await active.db.destroy()
        active = createDb(databaseUrl)
        await runMigrations(active.db)
        app = await buildApp({ config, db: active.db, dialect, store, hub })
        address = await app.listen({ port, host: '127.0.0.1' })
      },
      async close() {
        try {
          await app.close()
        } finally {
          try {
            await active.db.destroy()
          } finally {
            await handle.close()
            await rm(dir, { recursive: true, force: true })
          }
        }
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
            await sql.raw(`drop database if exists "${name}" with (force)`).execute(cleanup.db)
          } finally {
            await cleanup.close()
          }
        }
      })()
      return closing
    },
  }
}
