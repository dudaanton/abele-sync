import { PostgresAdapter, sql, type Kysely } from 'kysely'
import type { Database } from './schema.js'
import { assertNoLegacyGroupEvidence } from './legacyGroupPreflight.js'

/** Exact-prefix ancestry only. Never repair a journal or reinterpret incompatible schemas. */
export function assertMigrationAncestry(
  journal: readonly string[],
  chain: readonly string[]
): void {
  if (journal.length > chain.length || journal.some((name, i) => name !== chain[i])) {
    throw new Error(
      'incompatible migration ancestry; stop and plan export/import for unsupported schemas; never edit the journal'
    )
  }
}

/** Read only our schema's journal. This must run before Kysely creates bookkeeping tables. */
export async function readMigrationJournal(
  db: Kysely<Database>,
  schema: string | null
): Promise<string[]> {
  const pg = db.getExecutor().adapter instanceof PostgresAdapter
  const exists = pg
    ? (
        await sql`select 1 from information_schema.tables
        where table_schema = ${schema} and table_name = 'kysely_migration'`.execute(db)
      ).rows.length > 0
    : (
        await sql`select 1 from sqlite_master
        where type = 'table' and name = 'kysely_migration'`.execute(db)
      ).rows.length > 0
  if (!exists) return []
  const table = schema === null ? 'kysely_migration' : `${schema}.kysely_migration`
  const { rows } = await sql<{
    name: string
  }>`select name from ${sql.table(table)} order by name`.execute(db)
  return rows.map((row) => row.name)
}

/** Earlier incompatible scoped table shapes require a compatible migration or
 * planned export/import, never a journal rewrite or silent repair.
 */
export async function assertScopedSchemaShape(
  db: Kysely<Database>,
  schema: string | null,
  journal: readonly string[]
): Promise<void> {
  if (!journal.includes('008_scoped_authority')) return
  const rows =
    db.getExecutor().adapter instanceof PostgresAdapter
      ? (
          await sql`select column_name from information_schema.columns where table_schema = ${schema}
        and table_name = 'version_security_sources' and column_name = 'source_namespaces'`.execute(
            db
          )
        ).rows
      : (
          await sql`select name from pragma_table_info('version_security_sources') where name = 'source_namespaces'`.execute(
            db
          )
        ).rows
  if (rows.length !== 1)
    throw new Error(
      'incompatible scoped schema; stop and review migration/export-import for earlier 008, never edit journals'
    )
  if (!journal.includes('009_scoped_views')) return
  const preparation =
    db.getExecutor().adapter instanceof PostgresAdapter
      ? (
          await sql`select 1 from information_schema.tables where table_schema = ${schema}
        and table_name = 'scope_folder_preparations'`.execute(db)
        ).rows
      : (
          await sql`select 1 from sqlite_master where type = 'table' and name = 'scope_folder_preparations'`.execute(
            db
          )
        ).rows
  if (preparation.length !== 1)
    throw new Error(
      'incompatible scoped schema; earlier 009 needs a separately reviewed migration/export-import'
    )
  if (!journal.includes('010_version_path_keys')) await assertNoLegacyGroupEvidence(db)
  if (journal.includes('010_version_path_keys')) {
    const columns =
      db.getExecutor().adapter instanceof PostgresAdapter
        ? (
            await sql`select 1 from information_schema.columns where table_schema=${schema} and table_name='versions' and column_name='path_ci'`.execute(
              db
            )
          ).rows
        : (await sql`select 1 from pragma_table_info('versions') where name='path_ci'`.execute(db))
            .rows
    const indexes =
      db.getExecutor().adapter instanceof PostgresAdapter
        ? (
            await sql`select 1 from pg_indexes where schemaname=${schema} and tablename='versions' and indexname='versions_vault_path_ci_seq'`.execute(
              db
            )
          ).rows
        : (
            await sql`select 1 from sqlite_master where type='index' and tbl_name='versions' and name='versions_vault_path_ci_seq'`.execute(
              db
            )
          ).rows
    if (columns.length !== 1 || indexes.length !== 1)
      throw new Error(
        'incompatible historical path schema; stop and review migration/export-import, never edit journals'
      )
  }
}

/** Operational attestations, not proof manufactured by a migration or a test fixture. */
export interface UpgradeEvidence {
  database: string
  sourceRevision: string
  writersStopped: true
  collectorsStopped: true
  databaseBackup: string
  blobBackup: string
}

export function assertUpgradeEvidence(value: unknown): asserts value is UpgradeEvidence {
  const e = value as Partial<UpgradeEvidence> | null
  const text = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  if (
    !e ||
    !text(e.database) ||
    !text(e.databaseBackup) ||
    !text(e.blobBackup) ||
    typeof e.sourceRevision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(e.sourceRevision) ||
    e.writersStopped !== true ||
    e.collectorsStopped !== true
  ) {
    throw new Error(
      'upgrade evidence requires database, deployed commit, stopped writers/collectors, database and blob backups'
    )
  }
}
