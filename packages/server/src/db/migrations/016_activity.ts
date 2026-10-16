import { type Kysely } from 'kysely'
export async function up(db: Kysely<unknown>) {
  await db.schema
    .createTable('scope_deletions')
    .addColumn('secret_hash', 'text', (c) => c.primaryKey())
    .addColumn('deleted_at', 'text', (c) => c.notNull())
    .execute()
  for (const name of ['scope_deleted_at', 'last_used_at', 'last_address'])
    await db.schema.alterTable('access_tokens').addColumn(name, 'text').execute()
  await db.schema
    .alterTable('access_tokens')
    .addColumn('address_status', 'text', (c) => c.notNull().defaultTo('unknown'))
    .execute()
  await db.schema
    .createTable('activity_daily')
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('token_id', 'text', (c) => c.notNull())
    .addColumn('day', 'text', (c) => c.notNull())
    .addColumn('uploaded_files', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('uploaded_bytes', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('downloaded_files', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('downloaded_bytes', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('commits', 'bigint', (c) => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint('activity_daily_pk', ['vault_id', 'token_id', 'day'])
    .execute()
  // Retained administrative audit entries prove which existing revocations came from deletion.
  const typed = db as Kysely<import('../schema.js').Database>
  const rows = await typed
    .selectFrom('audit')
    .select(['vault_id', 'at', 'details'])
    .where('action', 'in', ['folder.delete', 'connection.delete'])
    .execute()
  for (const row of rows) {
    const details = JSON.parse(row.details) as { revoked_tokens?: unknown }
    if (!Array.isArray(details.revoked_tokens)) continue
    for (const id of details.revoked_tokens)
      if (typeof id === 'string')
        await typed
          .updateTable('access_tokens')
          .set({ scope_deleted_at: row.at })
          .where('space_id', '=', row.vault_id)
          .where('id', '=', id)
          .where('revoked_at', '=', row.at)
          .execute()
  }
  const deleted = await typed
    .selectFrom('spaces')
    .select(['id', 'deleted_at'])
    .where('deleted_at', 'is not', null)
    .execute()
  for (const space of deleted)
    await typed
      .updateTable('access_tokens')
      .set({ scope_deleted_at: space.deleted_at })
      .where('space_id', '=', space.id)
      .where('revoked_at', '=', space.deleted_at)
      .execute()
}
