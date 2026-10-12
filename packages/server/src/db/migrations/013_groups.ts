import type { Kysely } from 'kysely'

/** Indexed graph facts, never account/sponsor/admission state. */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('group_notes')
    .addColumn('space_id', 'text', (c) => c.notNull().references('spaces.id'))
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('signature', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('group_notes_pk', ['space_id', 'file_id'])
    .execute()
  await db.schema
    .createTable('group_names')
    .addColumn('space_id', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addColumn('exact', 'integer', (c) => c.notNull())
    .addPrimaryKeyConstraint('group_names_pk', ['space_id', 'name', 'file_id'])
    .execute()
  await db.schema
    .createIndex('group_names_file')
    .on('group_names')
    .columns(['space_id', 'file_id'])
    .execute()
  await db.schema
    .createTable('group_links')
    .addColumn('space_id', 'text', (c) => c.notNull().references('spaces.id'))
    .addColumn('source_id', 'text', (c) => c.notNull())
    .addColumn('link', 'text', (c) => c.notNull())
    .addColumn('target_id', 'text')
    .addPrimaryKeyConstraint('group_links_pk', ['space_id', 'source_id', 'link'])
    .execute()
  await db.schema
    .createIndex('group_links_target')
    .on('group_links')
    .columns(['space_id', 'target_id'])
    .execute()
  await db.schema
    .createIndex('group_links_spelling')
    .on('group_links')
    .columns(['space_id', 'link'])
    .execute()
  await db.schema
    .createTable('group_assets')
    .addColumn('space_id', 'text', (c) => c.notNull().references('spaces.id'))
    .addColumn('root_id', 'text', (c) => c.notNull())
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addColumn('published_by', 'text', (c) => c.notNull().references('access_tokens.id'))
    .addColumn('published_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('group_assets_pk', ['space_id', 'root_id', 'file_id'])
    .execute()
  await db.schema
    .createIndex('group_assets_file')
    .on('group_assets')
    .columns(['space_id', 'file_id'])
    .execute()
  await db.schema
    .createTable('group_copies')
    .addColumn('space_id', 'text', (c) => c.notNull().references('spaces.id'))
    .addColumn('original_id', 'text', (c) => c.notNull())
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('group_copies_pk', ['space_id', 'original_id', 'file_id'])
    .execute()
  await db.schema
    .createIndex('group_copies_file')
    .on('group_copies')
    .columns(['space_id', 'file_id'])
    .execute()
  await db.schema
    .createTable('group_write_bases')
    .addColumn('token_id', 'text', (c) => c.notNull().references('access_tokens.id'))
    .addColumn('file_id', 'text', (c) => c.notNull())
    .addColumn('version_id', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('group_write_bases_pk', ['token_id', 'file_id'])
    .execute()
  await db.schema
    .createIndex('scope_members_file')
    .on('scope_members')
    .columns(['file_id', 'scope_id'])
    .execute()
}
