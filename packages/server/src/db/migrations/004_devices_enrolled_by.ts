import type { Kysely } from 'kysely'

/**
 * A device may enrol another on its own vault (a transfer does, so the device it
 * sets up gets a token of its own). Revoking a stolen token does not revoke the
 * siblings it minted, so which device asked is kept for whoever reads the list.
 * Rows from before this migration were all enrolled by an account: null.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('devices').addColumn('enrolled_by', 'text').execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('devices').dropColumn('enrolled_by').execute()
}
