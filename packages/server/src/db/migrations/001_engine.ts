import { sql, type Kysely } from 'kysely'

/** Retained file engine storage, created fresh at its current shape. No old access tables. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('vault_seq')
    .addColumn('vault_id', 'text', (c) => c.primaryKey())
    .addColumn('head_seq', 'bigint', (c) => c.notNull())
    .addColumn('epoch', 'bigint', (c) => c.notNull().defaultTo(0))
    .execute()

  await db.schema
    .createTable('files')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('path_ci', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('head_version_id', 'text')
    .addColumn('deleted_at', 'text')
    .execute()

  await db.schema
    .createIndex('files_live_path')
    .on('files')
    .columns(['vault_id', 'path_ci'])
    .unique()
    .where(sql.ref('deleted_at'), 'is', null)
    .execute()

  await db.schema
    .createIndex('files_vault_path')
    .on('files')
    .columns(['vault_id', 'path'])
    .execute()

  await db.schema
    .createTable('versions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('seq', 'bigint', (c) => c.notNull())
    .addColumn('no', 'integer', (c) => c.notNull())
    .addColumn('op', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('path_ci', 'text')
    .addColumn('prev_path', 'text')
    .addColumn('blob_sha', 'text')
    .addColumn('size', 'bigint', (c) => c.notNull())
    .addColumn('mtime', 'bigint', (c) => c.notNull())
    .addColumn('actor_kind', 'text', (c) => c.notNull())
    .addColumn('actor_id', 'text', (c) => c.notNull())
    .addColumn('actor_name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('prev_version_id', 'text')
    .addColumn('merge', 'text')
    .addColumn('retention_class', 'text', (c) =>
      c.check(sql`retention_class in ('notes', 'attachments', 'settings')`)
    )
    .execute()

  await db.schema
    .createIndex('versions_vault_seq')
    .on('versions')
    .columns(['vault_id', 'seq'])
    .unique()
    .execute()

  await db.schema.createIndex('versions_file').on('versions').columns(['file_id', 'no']).execute()

  await db.schema
    .createTable('blobs')
    .addColumn('sha', 'text', (c) => c.primaryKey())
    .addColumn('size', 'bigint', (c) => c.notNull())
    .addColumn('storage_ref', 'text', (c) => c.notNull())
    .addColumn('refs', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('last_referenced_at', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('uploads')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('sha', 'text', (c) => c.notNull())
    .addColumn('size', 'bigint', (c) => c.notNull())
    .addColumn('part_size', 'bigint', (c) => c.notNull())
    .addColumn('parts_received', 'text', (c) => c.notNull())
    .addColumn('vault_id', 'text')
    .addColumn('device_id', 'text')
    .addColumn('completing_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('idempotency')
    .addColumn('actor_id', 'text', (c) => c.notNull())
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('request_hash', 'text', (c) => c.notNull())
    .addColumn('status', 'integer', (c) => c.notNull())
    .addColumn('response', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('idempotency_pk', ['actor_id', 'key'])
    .execute()

  await db.schema
    .createTable('audit')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('actor_kind', 'text', (c) => c.notNull())
    .addColumn('actor_id', 'text', (c) => c.notNull())
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('path', 'text')
    .addColumn('result', 'text', (c) => c.notNull())
    .addColumn('at', 'text', (c) => c.notNull())
    .addColumn('details', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('usage_daily')
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('day', 'text', (c) => c.notNull())
    .addColumn('live_bytes', 'bigint', (c) => c.notNull())
    .addColumn('history_bytes', 'bigint', (c) => c.notNull())
    .addColumn('trash_bytes', 'bigint', (c) => c.notNull())
    .addColumn('by_kind', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('usage_daily_pk', ['vault_id', 'day'])
    .execute()
  await db.schema
    .createTable('blob_uploads')
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('sha', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('size', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('blob_uploads_by_device_pk', ['vault_id', 'sha', 'device_id'])
    .execute()
  await db.schema.createIndex('blob_uploads_owner').on('blob_uploads').column('device_id').execute()
  await db.schema.createIndex('blob_uploads_blob').on('blob_uploads').column('sha').execute()
  await db.schema.createIndex('uploads_owner').on('uploads').column('device_id').execute()
  await db.schema.createIndex('uploads_vault').on('uploads').column('vault_id').execute()
  await db.schema
    .createIndex('versions_vault_sha')
    .on('versions')
    .columns(['vault_id', 'blob_sha'])
    .execute()
  await db.schema
    .createIndex('versions_vault_path_ci_seq')
    .on('versions')
    .columns(['vault_id', 'path_ci', 'seq'])
    .execute()
}
