import type { Kysely } from 'kysely'

/**
 * Bytes a device has uploaded that no version of its vault names yet. A `blobs` row only
 * exists once a version references a sha, so without this an upload nobody commits is
 * invisible: it counts against no quota and retention never sees it. One row per vault and
 * sha, naming the device that last sent it; a commit that references the sha removes it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('blob_uploads')
    .addColumn('vault_id', 'text', (c) => c.notNull())
    .addColumn('sha', 'text', (c) => c.notNull())
    .addColumn('device_id', 'text', (c) => c.notNull())
    .addColumn('size', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('blob_uploads_pk', ['vault_id', 'sha'])
    .execute()
  await db.schema
    .createIndex('blob_uploads_device')
    .on('blob_uploads')
    .column('device_id')
    .execute()
  await db.schema.createIndex('blob_uploads_sha').on('blob_uploads').column('sha').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('blob_uploads').execute()
}
