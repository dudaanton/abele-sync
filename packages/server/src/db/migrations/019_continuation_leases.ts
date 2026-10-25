import type { Kysely } from 'kysely'

export async function uploadsUp(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('uploads').addColumn('last_active_at', 'text').execute()
}

/** Existing snapshots infer their creation from the original one-hour expiry. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('scope_snapshots').addColumn('created_at', 'text').execute()
  await uploadsUp(db)
}
