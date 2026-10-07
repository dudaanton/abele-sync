import type { Kysely } from 'kysely'
import { caseKey } from '@abele/sync-protocol'
/** Canonical JS/NFC keys, never backend-specific lower()/NOCASE semantics.
 * Metadata is owned by the version row and disappears with normal payload GC.
 * Backfill, index and journal share the migrator's DDL transaction.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('versions').addColumn('path_ci', 'text').execute()
  const typed = db.withTables<{ versions: { id: string; path: string; path_ci: string | null } }>()
  let after: string | undefined
  for (;;) {
    let query = typed.selectFrom('versions').select(['id', 'path']).orderBy('id').limit(1000)
    if (after) query = query.where('id', '>', after)
    const rows = await query.execute()
    for (const row of rows)
      await typed
        .updateTable('versions')
        .set({ path_ci: caseKey(row.path) })
        .where('id', '=', row.id)
        .execute()
    if (rows.length < 1000) break
    after = rows.at(-1)!.id
  }
  await db.schema
    .createIndex('versions_vault_path_ci_seq')
    .on('versions')
    .columns(['vault_id', 'path_ci', 'seq', 'file_id'])
    .execute()
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('versions_vault_path_ci_seq').execute()
  await db.schema.alterTable('versions').dropColumn('path_ci').execute()
}
