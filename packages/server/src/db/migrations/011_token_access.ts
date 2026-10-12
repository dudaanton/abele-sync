import { sql, type Kysely } from 'kysely'

/** Fresh unified access tables. No account conversion, upgrade window or old-client compatibility. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('disabled_at', 'text')
    .execute()
  await db.schema
    .createTable('spaces')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().unique().references('users.id'))
    .addColumn('settings', 'text', (c) => c.notNull())
    .addColumn('address', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema
    .createTable('directories')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('space_id', 'text', (c) => c.notNull().references('spaces.id'))
    .addColumn('parent_id', 'text', (c) => c.references('directories.id'))
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('version_id', 'text', (c) => c.notNull())
    .addColumn('mtime', 'bigint', (c) => c.notNull())
    .addColumn('deleted_at', 'text')
    .execute()
  await db.schema
    .createIndex('directories_live_path')
    .on('directories')
    .columns(['space_id', 'path'])
    .unique()
    .where(sql.ref('deleted_at'), 'is', null)
    .execute()
  await db.schema
    .createIndex('directories_parent')
    .on('directories')
    .columns(['space_id', 'parent_id'])
    .execute()
  await db.schema
    .createTable('access_scopes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('space_id', 'text', (c) => c.notNull().references('spaces.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('target_id', 'text', (c) => c.notNull())
    .addColumn('boundary_scope_id', 'text', (c) => c.references('access_scopes.id'))
    .addColumn('effective_key', 'text', (c) => c.notNull())
    .addCheckConstraint('access_scope_kind', sql`kind in ('folder', 'group')`)
    .addUniqueConstraint('access_scope_effective', ['space_id', 'effective_key'])
    .execute()
  await db.schema
    .createTable('access_tokens')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('space_id', 'text', (c) => c.notNull().references('spaces.id'))
    .addColumn('secret_hash', 'text', (c) => c.notNull().unique())
    .addColumn('scope_id', 'text', (c) => c.notNull().references('access_scopes.id'))
    .addColumn('issued_by_token_id', 'text', (c) => c.references('access_tokens.id'))
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('revoked_at', 'text')
    .execute()
  await db.schema
    .createIndex('access_tokens_issuer')
    .on('access_tokens')
    .columns(['space_id', 'issued_by_token_id'])
    .execute()
}
export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['access_tokens', 'access_scopes', 'directories', 'spaces', 'users'])
    await db.schema.dropTable(table).execute()
}
