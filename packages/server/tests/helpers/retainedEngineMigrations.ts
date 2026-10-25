import { PostgresAdapter, sql, type Kysely } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import type { Database } from '../../src/db/schema.js'
import type {} from '../legacy/src/db/legacySchema.js'
import * as init from '../legacy/src/db/migrations/001_init.js'
import * as versionsVaultSha from '../legacy/src/db/migrations/002_versions_vault_sha.js'
import * as wideNumbers from '../legacy/src/db/migrations/003_wide_numbers.js'
import * as devicesEnrolledBy from '../legacy/src/db/migrations/004_devices_enrolled_by.js'
import * as blobUploads from '../legacy/src/db/migrations/005_blob_uploads.js'
import * as uploadOwners from '../legacy/src/db/migrations/006_upload_owners.js'
import * as versionRetentionClass from '../legacy/src/db/migrations/007_version_retention_class.js'
import * as versionPaths from '../legacy/src/db/migrations/010_version_path_keys.js'
import * as conflicts from '../../src/db/migrations/011_conflict_divergences.js'
import { uploadsUp } from '../../src/db/migrations/019_continuation_leases.js'

/** Test-only old transport bootstrap for independent engine regressions, not an upgrade path. */
const migrations = {
  '014_test_upload_lease': { up: uploadsUp },
  '001_init': init,
  '002_versions_vault_sha': versionsVaultSha,
  '003_wide_numbers': wideNumbers,
  '004_devices_enrolled_by': devicesEnrolledBy,
  '005_blob_uploads': blobUploads,
  '006_upload_owners': uploadOwners,
  '007_version_retention_class': versionRetentionClass,
  '008_test_authority': {
    up: async (db: Kysely<unknown>) => {
      await db.schema.alterTable('account_tokens').addColumn('issued_at', 'text').execute()
      await db.schema
        .createTable('account_authority')
        .addColumn('account_id', 'text', (c) => c.primaryKey())
        .addColumn('revision', 'bigint', (c) => c.notNull().defaultTo(0))
        .execute()
    },
  },
  '010_version_path_keys': versionPaths,
  '012_conflicts': {
    up: async (db: Kysely<unknown>) => {
      await conflicts.up(db, 'vaults')
    },
  },
  // Explicit directory metadata is now part of engine destination checks. The
  // retained file-only fixtures have an empty catalog, not a runtime SQL fallback.
  '013_test_directory_catalog': {
    up: async (db: Kysely<unknown>) => {
      await db.schema
        .createTable('directories')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('space_id', 'text', (c) => c.notNull().references('vaults.id'))
        .addColumn('parent_id', 'text', (c) => c.references('directories.id'))
        .addColumn('path', 'text', (c) => c.notNull())
        .addColumn('version_id', 'text', (c) => c.notNull())
        .addColumn('seq', 'bigint', (c) => c.notNull().defaultTo(0))
        .addColumn('mtime', 'bigint', (c) => c.notNull())
        .addColumn('deleted_at', 'text')
        .execute()
    },
  },
  '011_test_space_catalog': {
    up: async (db: Kysely<unknown>) => {
      await sql`create view spaces as select id, settings, created_at from vaults`.execute(db)
    },
  },
}
export const migrationChain = Object.freeze(Object.keys(migrations).sort())
const provider: MigrationProvider = { getMigrations: async () => migrations }
export async function runRetainedEngineMigrations(
  db: Kysely<Database>,
  schema?: string,
  target?: string
) {
  const own = schema ?? (await currentSchema(db))
  if (target !== undefined && !migrationChain.includes(target))
    throw new Error('unknown test migration target')
  const migrator = new Migrator({
    db,
    provider,
    ...(own === null ? {} : { migrationTableSchema: own }),
  })
  const { error, results } =
    target === undefined ? await migrator.migrateToLatest() : await migrator.migrateTo(target)
  const failed = results?.find((result) => result.status === 'Error')
  if (failed) throw new Error(`test migration ${failed.migrationName} failed`, { cause: error })
  if (error) throw error
}
export async function currentSchema(db: Kysely<Database>): Promise<string | null> {
  if (!(db.getExecutor().adapter instanceof PostgresAdapter)) return null
  const found =
    (await sql<{ schema: string | null }>`select current_schema() as schema`.execute(db)).rows[0]
      ?.schema ?? null
  if (!found) throw new Error('the Postgres search_path names no schema that exists')
  return found
}
