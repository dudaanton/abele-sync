import type { Kysely } from 'kysely'

/**
 * The blob routes answer for one vault: a sha is served to a device only when a
 * version of that device's vault names it. That question is asked on every
 * HEAD and GET of a blob, so it gets an index of its own.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('versions_vault_sha')
    .on('versions')
    .columns(['vault_id', 'blob_sha'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('versions_vault_sha').execute()
}
