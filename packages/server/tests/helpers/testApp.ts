import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { buildApp } from '../../src/api/app.js'
import { createAccount } from '../../src/auth/accounts.js'
import { BlobStore } from '../../src/blobs/store.js'
import { loadConfig, type Config } from '../../src/config.js'
import type { Dialect } from '../../src/db/connect.js'
import type { Database } from '../../src/db/schema.js'
import { EventHub } from '../../src/events/hub.js'
import { api } from './client.js'
import { tempDb } from './tempDb.js'

/** The parts of the configuration a test may want to shrink or freeze. */
export interface TestAppOptions {
  now?: () => Date
  partBytes?: number
  simpleUploadBytes?: number
  maxFileBytes?: number
  wsHelloTimeoutMs?: number
  trustProxy?: boolean | string[]
  configurationDirectories?: readonly string[]
  scopedSharing?: boolean
  /** `pg` runs the server on `ABELE_TEST_PG_URL`, in a schema of its own; SQLite by default. */
  dialect?: Dialect
}

export interface TestApp {
  app: FastifyInstance
  db: Kysely<Database>
  store: BlobStore
  /** The hub the app notifies, so a test can count who is listening. */
  hub: EventHub
  dir: string
  /** Synthetic test connection URL for independent-pool race fixtures. */
  databaseUrl?: string
  close(): Promise<void>
  account(email?: string): Promise<{ accountId: string; accountToken: string }>
  vault(accountToken: string, name?: string): Promise<{ vaultId: string }>
  device(
    accountToken: string,
    vaultId: string,
    name?: string
  ): Promise<{ deviceId: string; deviceToken: string }>
}

/** The password every test account is given; only a test that logs in itself cares what it is. */
export const TEST_PASSWORD = 'pw'

/** The pepper the test server hashes tokens with, for a test that needs its own `AuthDeps`. */
export const TEST_TOKEN_PEPPER = 'test'

/**
 * A whole server on an in-memory database (or a throwaway Postgres schema) and a temporary blob directory. The
 * account, vault and device helpers go through the real routes, so every test
 * arrives at its subject the way a client would: authenticated.
 */
export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const dir = await mkdtemp(join(tmpdir(), 'abele-app-'))
  const blobDir = join(dir, 'blobs')
  await mkdir(blobDir, { recursive: true })
  const base = loadConfig({
    ABELE_MASTER_KEY: 'ab'.repeat(32),
    ABELE_TOKEN_PEPPER: TEST_TOKEN_PEPPER,
    ABELE_BLOB_DIR: blobDir,
  })
  const config: Config = {
    ...base,
    ...(opts.scopedSharing === undefined ? {} : { scopedSharing: opts.scopedSharing }),
    ...(opts.partBytes === undefined ? {} : { partBytes: opts.partBytes }),
    ...(opts.simpleUploadBytes === undefined ? {} : { simpleUploadBytes: opts.simpleUploadBytes }),
    ...(opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes }),
    ...(opts.wsHelloTimeoutMs === undefined ? {} : { wsHelloTimeoutMs: opts.wsHelloTimeoutMs }),
    ...(opts.trustProxy === undefined ? {} : { trustProxy: opts.trustProxy }),
    ...(opts.configurationDirectories === undefined
      ? {}
      : { configurationDirectories: opts.configurationDirectories }),
  }

  const handle = await tempDb(opts.dialect)
  const store = new BlobStore(blobDir, config.masterKey)
  const hub = new EventHub()
  const app = await buildApp({
    config,
    db: handle.db,
    dialect: handle.dialect,
    store,
    hub,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })

  const authDeps = {
    db: handle.db,
    pepper: config.tokenPepper,
    accountTokenTtlMs: config.accountTokenTtlMs,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  }

  /** Fail loudly with the server's own words rather than on an undefined field later. */
  const ensure = (what: string, res: { status: number; raw: string }, wanted: number): void => {
    if (res.status !== wanted) throw new Error(`${what} answered ${res.status}: ${res.raw}`)
  }

  return {
    app,
    db: handle.db,
    store,
    hub,
    dir,
    ...(handle.url === undefined ? {} : { databaseUrl: handle.url }),

    async close() {
      await app.close()
      await handle.close()
      await rm(dir, { recursive: true, force: true })
    },

    async account(email = `${randomUUID()}@test.io`) {
      const { id } = await createAccount(authDeps, email, TEST_PASSWORD)
      const res = await api(app).post('/v1/auth/login', { email, password: TEST_PASSWORD })
      ensure('login', res, 200)
      return { accountId: id, accountToken: res.body.account_token as string }
    },

    async vault(accountToken: string, name = 'Vault') {
      const res = await api(app, accountToken).post('/v1/vaults', { name })
      ensure('create vault', res, 201)
      return { vaultId: res.body.id as string }
    },

    async device(accountToken: string, vaultId: string, name = 'device') {
      const res = await api(app, accountToken).post('/v1/devices', {
        vault_id: vaultId,
        name,
        platform: 'desktop',
      })
      ensure('enrol device', res, 201)
      return {
        deviceId: res.body.device_id as string,
        deviceToken: res.body.device_token as string,
      }
    },
  }
}
