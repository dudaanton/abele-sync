import { PostgresAdapter, sql, type Kysely } from 'kysely'

/**
 * A version's retention class is fixed when it is written, not taken from files.kind at GC.
 * Historical paths are already immutable. Under the pre-007 rules they fully determine
 * the class: notes/canvases, settings, or attachments (scripts share the attachment window).
 * Neither the current file kind nor the current scripts_folder can reconstruct that history.
 *
 * Null is unknown provenance and GC keeps it. This also fails safely if an older writer omits
 * the column; all current commit paths fill it. Stop old server processes before upgrading:
 * their collectors still use the vulnerable current-file-kind rule.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely wraps Postgres migrations, but not SQLite migrations. DDL and backfill must land
  // together on both; reuse the outer transaction rather than trying to nest one on Postgres.
  if (db.isTransaction) await addAndBackfill(db)
  else await db.transaction().execute(addAndBackfill)
}

async function addAndBackfill(db: Kysely<unknown>): Promise<void> {
  // SQLite can stop after this transaction commits but before Kysely records the migration.
  // Retrying must not fail on the column or overwrite a class a newer writer already stamped.
  if (!(await hasColumn(db))) {
    await db.schema
      .alterTable('versions')
      .addColumn('retention_class', 'text', (c) =>
        c.check(sql`retention_class in ('notes', 'attachments', 'settings')`)
      )
      .execute()
  }
  // Keep this historical classifier in the migration, independent of future protocol rules.
  // substr equality is case-sensitive on both dialects; SQLite LIKE alone would not be.
  await sql`update versions set retention_class = case
    when substr(path, 1, 10) = '.obsidian/' then 'settings'
    when lower(path) like '%.md' or lower(path) like '%.canvas' then 'notes'
    else 'attachments' end where retention_class is null`.execute(db)
}

async function hasColumn(db: Kysely<unknown>): Promise<boolean> {
  const query =
    db.getExecutor().adapter instanceof PostgresAdapter
      ? sql`select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'versions'
          and column_name = 'retention_class'`
      : sql`select name from pragma_table_info('versions') where name = 'retention_class'`
  return (await query.execute(db)).rows.length !== 0
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('versions').dropColumn('retention_class').execute()
}
