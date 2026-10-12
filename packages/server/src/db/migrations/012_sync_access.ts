import type { Kysely } from 'kysely'

/** Durable derived scope state. Engine versions/blobs remain unchanged. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('directories')
    .addColumn('seq', 'bigint', (c) => c.notNull().defaultTo(0))
    .execute()
  await db.schema
    .createTable('scope_members')
    .addColumn('scope_id', 'text', (c) => c.notNull().references('access_scopes.id'))
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addColumn('item', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('scope_members_pk', ['scope_id', 'file_id'])
    .execute()
  await db.schema
    .createTable('scope_versions')
    .addColumn('scope_id', 'text', (c) => c.notNull().references('access_scopes.id'))
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addColumn('version_id', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('scope_versions_pk', ['scope_id', 'version_id'])
    .execute()
  await db.schema
    .createTable('scope_changes')
    .addColumn('scope_id', 'text', (c) => c.notNull().references('access_scopes.id'))
    .addColumn('cursor', 'bigint', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('event', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('scope_changes_pk', ['scope_id', 'cursor'])
    .execute()
  await db.schema
    .createTable('scope_snapshots')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('scope_id', 'text', (c) => c.notNull().references('access_scopes.id'))
    .addColumn('cursor', 'bigint', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema
    .createTable('scope_snapshot_items')
    .addColumn('snapshot_id', 'text', (c) =>
      c.notNull().references('scope_snapshots.id').onDelete('cascade')
    )
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addColumn('item', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('scope_snapshot_items_pk', ['snapshot_id', 'file_id'])
    .execute()
}
