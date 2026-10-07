import { describe, it, expect } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { Migrator, type Migration } from 'kysely/migration'
import type { Dialect } from '../../src/db/connect.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Database } from '../../src/db/schema.js'
import * as init from '../../src/db/migrations/001_init.js'
import * as versionsVaultSha from '../../src/db/migrations/002_versions_vault_sha.js'
import { listVersions } from '../../src/history/versions.js'
import { bumpUsage, usage } from '../../src/history/usage.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'
import { buildTestApp } from '../helpers/testApp.js'

/**
 * Epoch milliseconds and byte counts do not fit in 32 bits. SQLite's `integer`
 * is 64-bit whatever it is called; Postgres's is not, so these columns are
 * `bigint` there, and node-pg hands `bigint` back as numbers rather than strings.
 */

/** A real mtime: today in epoch milliseconds, far past 2^31. */
const MTIME = 1_790_428_645_718
/** Past 2 GiB, and past 4 GiB for the sums. */
const HUGE = 3 * 2 ** 30

/** The columns that hold epoch milliseconds, byte counts, or a counter that only grows. */
const WIDE: [string, string][] = [
  ['versions', 'mtime'],
  ['versions', 'size'],
  ['versions', 'seq'],
  ['vault_seq', 'head_seq'],
  ['blobs', 'size'],
  ['uploads', 'size'],
  ['uploads', 'part_size'],
  ['usage_daily', 'live_bytes'],
  ['usage_daily', 'history_bytes'],
  ['usage_daily', 'trash_bytes'],
]

async function roundTrip(dialect: Dialect): Promise<void> {
  const t = await buildTestApp({ dialect })
  try {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)

    await putBlob(t.app, deviceToken, 'big\n')
    const r = await commit(t.app, deviceToken, vaultId, [create('Big.bin', 'big\n', MTIME)])
    expect(r.results[0]).toMatchObject({ status: 'applied', mtime: MTIME })
    const fileId = r.results[0].file_id as string

    const feed = await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/changes?since=0`)
    expect(feed.status).toBe(200)
    expect(feed.body.items[0]).toMatchObject({ mtime: MTIME, size: 4 })

    // No 3 GiB upload in a test: the row is made to say so, which is what the columns must hold.
    await t.db.updateTable('versions').set({ size: HUGE }).where('file_id', '=', fileId).execute()
    await t.db.updateTable('blobs').set({ size: HUGE }).execute()
    await t.db
      .insertInto('uploads')
      .values({
        id: 'u',
        sha: 'x',
        size: 2 * HUGE,
        part_size: HUGE,
        parts_received: '[]',
        created_at: 't',
      })
      .execute()

    const [version] = await listVersions(t.db, vaultId, fileId, { limit: 1 })
    expect(version).toMatchObject({ size: HUGE, mtime: MTIME, seq: 1 })
    expect(typeof version?.size).toBe('number')

    const blob = await t.db.selectFrom('blobs').select('size').executeTakeFirstOrThrow()
    expect(blob.size).toBe(HUGE)
    const upload = await t.db.selectFrom('uploads').selectAll().executeTakeFirstOrThrow()
    expect(upload).toMatchObject({ size: 2 * HUGE, part_size: HUGE })
    expect((await usage(t.db, vaultId)).live_bytes).toBe(HUGE)

    // The daily roll-up reads its row and adds to it: a string back from the driver would
    // concatenate instead.
    const delta = {
      live: HUGE,
      history: HUGE,
      trash: 1,
      kind: 'attachment' as const,
      countDelta: 1,
    }
    await t.db.transaction().execute(async (trx) => {
      await bumpUsage(trx, vaultId, '2030-01-01', delta)
      await bumpUsage(trx, vaultId, '2030-01-01', delta)
    })
    const day = await t.db
      .selectFrom('usage_daily')
      .selectAll()
      .where('day', '=', '2030-01-01')
      .executeTakeFirstOrThrow()
    expect(day).toMatchObject({ live_bytes: 2 * HUGE, history_bytes: 2 * HUGE, trash_bytes: 2 })
  } finally {
    await t.close()
  }
}

/** The first two migrations only: a database as a server before this change left it. */
async function upTo002(db: Kysely<Database>, schema?: string): Promise<void> {
  const migrations: Record<string, Migration> = {
    '001_init': init,
    '002_versions_vault_sha': versionsVaultSha,
  }
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
    ...(schema === undefined ? {} : { migrationTableSchema: schema }),
  })
  const { error } = await migrator.migrateToLatest()
  if (error) throw error
}

describe('wide numbers', () => {
  it('keeps epoch-ms mtimes and sizes past 2 GiB on sqlite', () => roundTrip('sqlite'))
  it('migrates a database made before the columns were widened', async () => {
    const { db, close } = await tempDb('sqlite', upTo002)
    try {
      await runMigrations(db)
      await runMigrations(db)
    } finally {
      await close()
    }
  })
})

describe.skipIf(!hasPgTestDb)('wide numbers on postgres', () => {
  it('keeps epoch-ms mtimes and sizes past 2 GiB', () => roundTrip('pg'))

  it('widens the columns of a database made before, keeping its rows', async () => {
    const { db, close, schema } = await tempDb('pg', upTo002)
    try {
      await db
        .insertInto('blobs')
        .values({
          sha: 's',
          size: 7,
          storage_ref: 'r',
          refs: 1,
          created_at: 't',
          last_referenced_at: 't',
        })
        .execute()
      await runMigrations(db, schema)

      const types = await sql<{ table_name: string; column_name: string; data_type: string }>`
        select table_name, column_name, data_type from information_schema.columns
        where table_schema = current_schema()`.execute(db)
      const typeOf = (table: string, column: string): string | undefined =>
        types.rows.find((r) => r.table_name === table && r.column_name === column)?.data_type
      for (const [table, column] of WIDE)
        expect([table, column, typeOf(table, column)]).toEqual([table, column, 'bigint'])

      const kept = await db.selectFrom('blobs').select(['sha', 'size']).execute()
      expect(kept).toEqual([{ sha: 's', size: 7 }])
      await db.updateTable('blobs').set({ size: HUGE }).execute()
      expect((await db.selectFrom('blobs').select('size').executeTakeFirstOrThrow()).size).toBe(
        HUGE
      )
    } finally {
      await close()
    }
  })
})
