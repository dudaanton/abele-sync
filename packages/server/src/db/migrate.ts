import { PostgresAdapter, sql, type Kysely } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'
import type { Database } from './schema.js'
import {
  assertMigrationAncestry,
  assertScopedSchemaShape,
  readMigrationJournal,
} from './upgradePreflight.js'
import * as init from './migrations/001_init.js'
import * as versionsVaultSha from './migrations/002_versions_vault_sha.js'
import * as wideNumbers from './migrations/003_wide_numbers.js'
import * as devicesEnrolledBy from './migrations/004_devices_enrolled_by.js'
import * as blobUploads from './migrations/005_blob_uploads.js'
import * as uploadOwners from './migrations/006_upload_owners.js'
import * as versionRetentionClass from './migrations/007_version_retention_class.js'
import * as scopedAuthority from './migrations/008_scoped_authority.js'
import * as scopedViews from './migrations/009_scoped_views.js'
import * as versionPaths from './migrations/010_version_path_keys.js'

/** Migrations are listed in code so the build never discovers files from disk. */
const migrations: Record<string, Migration> = {
  '001_init': { up: init.up, down: init.down },
  '002_versions_vault_sha': { up: versionsVaultSha.up, down: versionsVaultSha.down },
  '003_wide_numbers': { up: wideNumbers.up, down: wideNumbers.down },
  '004_devices_enrolled_by': { up: devicesEnrolledBy.up, down: devicesEnrolledBy.down },
  '005_blob_uploads': { up: blobUploads.up, down: blobUploads.down },
  '006_upload_owners': { up: uploadOwners.up, down: uploadOwners.down },
  '007_version_retention_class': { up: versionRetentionClass.up, down: versionRetentionClass.down },
  '008_scoped_authority': { up: scopedAuthority.up, down: scopedAuthority.down },
  '009_scoped_views': { up: scopedViews.up, down: scopedViews.down },
  '010_version_path_keys': { up: versionPaths.up, down: versionPaths.down },
}

export const migrationChain: readonly string[] = Object.freeze(Object.keys(migrations).sort())

const provider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations),
}

/**
 * Bring the database up to the latest migration. Safe to call on an already-migrated database.
 *
 * On Postgres, Kysely's own bookkeeping tables are pinned to the schema the connection works
 * in, `current_schema()` unless `schema` names one. Left to itself Kysely asks whether they
 * exist in *any* schema, so a database that holds another Kysely-migrated schema — a second
 * app, an old test run — would have it find that one's tables and never create its own.
 */
export async function runMigrations(
  db: Kysely<Database>,
  schema?: string,
  target?: string
): Promise<void> {
  const own = schema ?? (await currentSchema(db))
  const journal = await readMigrationJournal(db, own)
  assertMigrationAncestry(journal, migrationChain)
  await assertScopedSchemaShape(db, own, journal)
  if (target !== undefined) {
    const position = migrationChain.indexOf(target)
    if (position < 0) throw new Error('unknown migration target')
    if (position + 1 < journal.length) throw new Error('destructive migration downgrade is refused')
  }
  const migrator = new Migrator({
    db,
    provider,
    ...(own === null ? {} : { migrationTableSchema: own }),
  })
  const { error, results } =
    target === undefined ? await migrator.migrateToLatest() : await migrator.migrateTo(target)
  const failed = results?.find((r) => r.status === 'Error')
  if (failed) throw new Error(`migration ${failed.migrationName} failed`, { cause: error })
  if (error) throw error instanceof Error ? error : new Error(String(error))
}

/** The schema a Postgres connection creates tables in; null on SQLite, which has none. */
export async function currentSchema(db: Kysely<Database>): Promise<string | null> {
  if (!(db.getExecutor().adapter instanceof PostgresAdapter)) return null
  const { rows } = await sql<{ schema: string | null }>`select current_schema() as schema`.execute(
    db
  )
  const found = rows[0]?.schema ?? null
  // No schema on the search path that exists: nothing Kysely could create its tables in either.
  if (found === null) throw new Error('the Postgres search_path names no schema that exists')
  return found
}
