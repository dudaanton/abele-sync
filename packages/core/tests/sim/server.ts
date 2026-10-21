import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { buildApp } from '@abele/sync-server/src/api/app.js'
import { createDb } from '@abele/sync-server/src/db/connect.js'
import { runMigrations } from '@abele/sync-server/src/db/migrate.js'
import { BlobStore } from '@abele/sync-server/src/blobs/store.js'
import { EventHub } from '@abele/sync-server/src/events/hub.js'
import { loadConfig } from '@abele/sync-server/src/config.js'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { fetchFor } from '../helpers/serverFetch.js'
import { SimScheduler } from './scheduler.js'

/** Production v2 routes, no listener and no legacy retained-engine application. */
export async function simServer(scheduler: SimScheduler) {
  await mkdir(resolve('.scratch'), { recursive: true })
  const dir = await mkdtemp(resolve('.scratch/sim-'))
  const handle = createDb(`sqlite://${join(dir, 'server.db')}`)
  try {
    await runMigrations(handle.db)
    const config = loadConfig({ ABELE_MASTER_KEY: 'ab'.repeat(32), ABELE_TOKEN_PEPPER: 'simulation', ABELE_BLOB_DIR: join(dir, 'blobs') })
    const now = () => new Date(scheduler.time)
    const app = await buildApp({ config, db: handle.db, dialect: 'sqlite', store: new BlobStore(config.blobDir, config.masterKey), hub: new EventHub(), now })
    const root = await createUser({ db: handle.db, pepper: config.tokenPepper, dialect: 'sqlite', now }, 'Simulation', 'http://simulation.test')
    return { token: root.token, fetch: fetchFor(app), db: handle.db,
      async close() { await app.close(); await handle.close(); await rm(dir, { recursive: true, force: true }) },
    }
  } catch (error) { await handle.close(); await rm(dir, { recursive: true, force: true }); throw error }
}
