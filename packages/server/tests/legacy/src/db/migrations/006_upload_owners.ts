import { sql, type Kysely } from 'kysely'

/**
 * Who is waiting on what, per device, and who owns an upload in progress.
 *
 * `blob_uploads` kept one row per vault and sha, naming the device that sent the bytes last:
 * revoking that device took the row, and with it the bytes, from under every other device still
 * waiting to commit the same sha. It is keyed by device as well now, so a sha is kept while any
 * device of the vault waits on it.
 *
 * `uploads` learns its vault and device, so a revoked device's uploads in progress go with it
 * and the parts it holds count against its vault's quota; and when its completion began, so no
 * part can change while the parts are being joined. Rows from before carry none of these, and
 * are swept within the day like any upload nobody finishes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('blob_uploads_by_device')
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('sha', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('size', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('blob_uploads_by_device_pk', ['vault_id', 'sha', 'device_id'])
    .execute()
  await sql`insert into blob_uploads_by_device (vault_id, sha, device_id, size, created_at)
            select vault_id, sha, device_id, size, created_at from blob_uploads`.execute(db)
  await db.schema.dropTable('blob_uploads').execute()
  await db.schema.alterTable('blob_uploads_by_device').renameTo('blob_uploads').execute()
  await db.schema.createIndex('blob_uploads_owner').on('blob_uploads').column('device_id').execute()
  await db.schema.createIndex('blob_uploads_blob').on('blob_uploads').column('sha').execute()

  await db.schema.alterTable('uploads').addColumn('vault_id', 'text').execute()
  await db.schema.alterTable('uploads').addColumn('device_id', 'text').execute()
  await db.schema.alterTable('uploads').addColumn('completing_at', 'text').execute()
  await db.schema.createIndex('uploads_owner').on('uploads').column('device_id').execute()
  await db.schema.createIndex('uploads_vault').on('uploads').column('vault_id').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('uploads_vault').execute()
  await db.schema.dropIndex('uploads_owner').execute()
  await db.schema.alterTable('uploads').dropColumn('completing_at').execute()
  await db.schema.alterTable('uploads').dropColumn('device_id').execute()
  await db.schema.alterTable('uploads').dropColumn('vault_id').execute()

  // One row per vault and sha again: the newest upload of each stands for it.
  await db.schema
    .createTable('blob_uploads_by_blob')
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('sha', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('size', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('blob_uploads_pk', ['vault_id', 'sha'])
    .execute()
  await sql`insert into blob_uploads_by_blob (vault_id, sha, device_id, size, created_at)
            select vault_id, sha, max(device_id), max(size), max(created_at)
            from blob_uploads group by vault_id, sha`.execute(db)
  await db.schema.dropTable('blob_uploads').execute()
  await db.schema.alterTable('blob_uploads_by_blob').renameTo('blob_uploads').execute()
  await db.schema
    .createIndex('blob_uploads_device')
    .on('blob_uploads')
    .column('device_id')
    .execute()
  await db.schema.createIndex('blob_uploads_sha').on('blob_uploads').column('sha').execute()
}
