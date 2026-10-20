import { PostgresAdapter, sql, type Kysely } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import type { Database } from './schema.js'
import * as items from './migrations/018_token_items.js'
import * as activity from './migrations/016_activity.js'
import * as generation from './migrations/017_generation.js'
import * as readOnly from './migrations/015_read_only.js'
import * as operator from './migrations/014_operator.js'
import * as engine from './migrations/001_engine.js'
import * as tokens from './migrations/011_token_access.js'
import * as sync from './migrations/012_sync_access.js'
import * as groups from './migrations/013_groups.js'
import * as conflictDivergences from './migrations/011_conflict_divergences.js'

/** Token schema upgrades preserve existing data; retired account schemas are refused. */
export const migrationChain = Object.freeze([
  '001_engine',
  '002_token_access',
  '003_sync_access',
  '004_conflict_divergences',
  '005_groups',
  '006_operator',
  '007_read_only',
  '008_activity',
  '009_generation',
  '010_token_items',
])
const provider: MigrationProvider = {
  getMigrations: async () => ({
    '001_engine': { up: engine.up },
    '002_token_access': { up: tokens.up },
    '003_sync_access': { up: sync.up },
    '004_conflict_divergences': { up: conflictDivergences.up, down: conflictDivergences.down },
    '005_groups': { up: groups.up },
    '006_operator': { up: operator.up },
    '007_read_only': { up: readOnly.up },
    '008_activity': { up: activity.up },
    '009_generation': { up: generation.up },
    '010_token_items': { up: items.up },
  }),
}
export async function runMigrations(
  db: Kysely<Database>,
  schema?: string,
  target?: string
): Promise<void> {
  if (!(db.getExecutor().adapter instanceof PostgresAdapter)) {
    // SQLite cannot change foreign_keys inside Migrator's DDL transaction. Pin
    // the connection and restore enforcement even when a migration rolls back.
    return db.connection().execute(async (connection) => {
      await sql`pragma foreign_keys = off`.execute(connection)
      try {
        await migrate(connection, schema, target)
      } finally {
        await sql`pragma foreign_keys = on`.execute(connection)
      }
    })
  }
  return migrate(db, schema, target)
}
async function migrate(db: Kysely<Database>, schema?: string, target?: string): Promise<void> {
  const own = schema ?? (await currentSchema(db))
  const pg = own !== null
  const old = pg
    ? (
        await sql`select 1 from information_schema.tables where table_schema = ${own} and table_name in ('accounts', 'devices', 'scope_grants')`.execute(
          db
        )
      ).rows
    : (
        await sql`select 1 from sqlite_master where type = 'table' and name in ('accounts', 'devices', 'scope_grants')`.execute(
          db
        )
      ).rows
  if (old.length > 0)
    throw new Error(
      'token sync requires a fresh database; wipe the unused test stand, no data conversion is supported'
    )
  if (target !== undefined && !migrationChain.includes(target))
    throw new Error('unknown fresh-schema target')
  const migrator = new Migrator({
    db,
    provider,
    ...(own === null ? {} : { migrationTableSchema: own }),
  })
  const { error, results } =
    target === undefined ? await migrator.migrateToLatest() : await migrator.migrateTo(target)
  const failed = results?.find((result) => result.status === 'Error')
  if (failed !== undefined)
    throw new Error(`fresh schema ${failed.migrationName} failed`, { cause: error })
  if (error) throw error
  if (target === undefined || target === '004_conflict_divergences') {
    const tables = await db.introspection.getTables()
    const identity = tables.find(
      (table) => table.name === 'conflict_divergences' && (!pg || table.schema === own)
    )
    if (
      !identity ||
      ![
        'divergence_key',
        'vault_id',
        'original_file_id',
        'base_identity',
        'incoming_sha',
        'create_path_ci',
        'conflict_file_id',
        'conflict_version_id',
        'first_head_version_id',
        'chosen_path',
        'created_at',
        'disposition',
      ].every((name) => identity.columns.some((column) => column.name === name))
    )
      throw new Error('missing or incomplete conflict identity schema')
  }
}
export async function currentSchema(db: Kysely<Database>): Promise<string | null> {
  if (!(db.getExecutor().adapter instanceof PostgresAdapter)) return null
  const found =
    (await sql<{ schema: string | null }>`select current_schema() as schema`.execute(db)).rows[0]
      ?.schema ?? null
  if (found === null) throw new Error('the Postgres search_path names no schema that exists')
  return found
}
