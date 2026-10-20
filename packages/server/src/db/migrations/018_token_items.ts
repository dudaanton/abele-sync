import { PostgresAdapter, sql, type Kysely } from 'kysely'

/** Preserve primary scope ids and every existing foreign key and feed. */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (db.getExecutor().adapter instanceof PostgresAdapter) {
    await db.schema.alterTable('access_scopes').dropConstraint('access_scope_kind').execute()
    await db.schema
      .alterTable('access_scopes')
      .addCheckConstraint('access_scope_kind', sql`kind in ('folder', 'group', 'file')`)
      .execute()
  } else {
    await db.schema
      .createTable('access_scopes_items_upgrade')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('space_id', 'text', (c) => c.notNull().references('spaces.id'))
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('target_id', 'text', (c) => c.notNull())
      .addColumn('boundary_scope_id', 'text', (c) => c.references('access_scopes.id'))
      .addColumn('effective_key', 'text', (c) => c.notNull())
      .addCheckConstraint('access_scope_kind', sql`kind in ('folder', 'group', 'file')`)
      .addUniqueConstraint('access_scope_effective', ['space_id', 'effective_key'])
      .execute()
    await sql`insert into access_scopes_items_upgrade select * from access_scopes`.execute(db)
    await db.schema.dropTable('access_scopes').execute()
    await db.schema.alterTable('access_scopes_items_upgrade').renameTo('access_scopes').execute()
    const check = await sql`pragma foreign_key_check`.execute(db)
    if (check.rows.length) throw new Error('item migration broke scope foreign keys')
  }
  await db.schema
    .createTable('access_token_items')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('token_id', 'text', (c) => c.notNull().references('access_tokens.id'))
    .addColumn('scope_id', 'text', (c) => c.notNull().references('access_scopes.id'))
    .addColumn('added_by_token_id', 'text', (c) => c.references('access_tokens.id'))
    .addColumn('added_at', 'text', (c) => c.notNull())
    .addColumn('removed_at', 'text')
    .execute()
  await db.schema
    .createIndex('access_token_items_token')
    .on('access_token_items')
    .columns(['token_id'])
    .execute()
}
