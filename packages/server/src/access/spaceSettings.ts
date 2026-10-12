import { AbeleError, VaultSettingsSchema, type VaultSettings } from '@abele/sync-protocol'
import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'

/** Engine policy is stored on the token's space, never an account-selected vault. */
export async function getVaultSettings(
  deps: { db: Kysely<Database> },
  id: string
): Promise<VaultSettings> {
  const row = await deps.db
    .selectFrom('spaces')
    .select('settings')
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw new AbeleError('not_found', 'no such space')
  return VaultSettingsSchema.parse(JSON.parse(row.settings))
}
