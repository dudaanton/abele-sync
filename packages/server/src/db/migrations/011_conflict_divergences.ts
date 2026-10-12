import type { Kysely } from 'kysely'

/** Durable lineage, not payload retention. Only vault deletion cascades; no file/version FK. */
export async function up(db: Kysely<unknown>, ownerTable = 'spaces'): Promise<void> {
  await db.schema
    .createTable('conflict_divergences')
    .addColumn('divergence_key', 'text', (c) => c.notNull().primaryKey())
    .addColumn('vault_id', 'text', (c) =>
      c.notNull().references(`${ownerTable}.id`).onDelete('cascade')
    )
    .addColumn('original_file_id', 'text', (c) => c.notNull())
    .addColumn('base_identity', 'text', (c) => c.notNull())
    .addColumn('incoming_sha', 'text', (c) => c.notNull())
    // A create has no wire file ID. Retain explicit submitted-path evidence solely to
    // locate its original identity after a rename; it is never part of the branch key.
    .addColumn('create_path_ci', 'text')
    .addColumn('conflict_file_id', 'text', (c) => c.notNull())
    .addColumn('conflict_version_id', 'text', (c) => c.notNull())
    .addColumn('first_head_version_id', 'text', (c) => c.notNull())
    .addColumn('chosen_path', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('disposition', 'text', (c) => c.notNull())
    .addUniqueConstraint('conflict_divergences_source', [
      'vault_id',
      'original_file_id',
      'base_identity',
      'incoming_sha',
    ])
    .execute()
  await db.schema
    .createIndex('conflict_divergences_create_lookup')
    .on('conflict_divergences')
    .columns(['vault_id', 'create_path_ci', 'incoming_sha'])
    .execute()
  await db.schema
    .createIndex('conflict_divergences_copy')
    .on('conflict_divergences')
    .columns(['vault_id', 'conflict_file_id'])
    .execute()
}
export async function down(_db: Kysely<unknown>): Promise<void> {
  throw new Error('conflict identity downgrade is unsafe; restore the pre-upgrade backup')
}
