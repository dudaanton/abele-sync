import { sql, type Kysely } from 'kysely'

/**
 * The initial schema. Every timestamp column is text holding an ISO-8601
 * instant in UTC; the database never fills one in for us.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('accounts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('disabled_at', 'text')
    .execute()

  await db.schema
    .createTable('account_tokens')
    .addColumn('token_hash', 'text', (c) => c.primaryKey())
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('vaults')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('owner_account_id', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('settings', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('vault_members')
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('vault_members_pk', ['vault_id', 'account_id'])
    .execute()

  await db.schema
    .createTable('vault_seq')
    .addColumn('vault_id', 'text', (c) => c.primaryKey())
    .addColumn('head_seq', 'integer', (c) => c.notNull())
    .addColumn('epoch', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()

  await db.schema
    .createTable('devices')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('platform', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('selective', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('last_seen_at', 'text')
    .addColumn('revoked_at', 'text')
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
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('no', 'integer', (c) => c.notNull())
    .addColumn('op', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('prev_path', 'text')
    .addColumn('blob_sha', 'text')
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('mtime', 'integer', (c) => c.notNull())
    .addColumn('actor_kind', 'text', (c) => c.notNull())
    .addColumn('actor_id', 'text', (c) => c.notNull())
    .addColumn('actor_name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('prev_version_id', 'text')
    .addColumn('merge', 'text')
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
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('storage_ref', 'text', (c) => c.notNull())
    .addColumn('refs', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('last_referenced_at', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('uploads')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('sha', 'text', (c) => c.notNull())
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('part_size', 'integer', (c) => c.notNull())
    .addColumn('parts_received', 'text', (c) => c.notNull())
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
    .addColumn('live_bytes', 'integer', (c) => c.notNull())
    .addColumn('history_bytes', 'integer', (c) => c.notNull())
    .addColumn('trash_bytes', 'integer', (c) => c.notNull())
    .addColumn('by_kind', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('usage_daily_pk', ['vault_id', 'day'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const index of [
    'versions_file',
    'versions_vault_seq',
    'files_vault_path',
    'files_live_path',
  ]) {
    await db.schema.dropIndex(index).execute()
  }
  for (const table of [
    'usage_daily',
    'audit',
    'idempotency',
    'uploads',
    'blobs',
    'versions',
    'files',
    'devices',
    'vault_seq',
    'vault_members',
    'vaults',
    'account_tokens',
    'accounts',
  ]) {
    await db.schema.dropTable(table).execute()
  }
}
