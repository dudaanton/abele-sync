import {
  AbeleError,
  VaultSettingsSchema,
  type VaultInfo,
  type VaultSettings,
  type VaultSettingsPatch,
  type VaultState,
} from '@abele/sync-protocol'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { DeviceIdentity } from '../auth/devices.js'
import type { Dialect } from '../db/connect.js'
import { readJson, writeJson } from '../db/json.js'
import type { Database } from '../db/schema.js'
import { usage } from '../history/usage.js'
import { fileKind } from '../oplog/kinds.js'
import { withVaultLock } from '../oplog/lock.js'
import { newId, nowIso } from '../ids.js'
import { authorizeSettingsUpdate, type SettingsProof } from './settingsAuth.js'

/** Create a vault with default settings, an empty sequence and its owner as the first member. */
export async function createVault(
  deps: { db: Kysely<Database> },
  ownerAccountId: string,
  name: string
): Promise<{ id: string }> {
  const id = newId()
  await deps.db.transaction().execute(async (tx) => {
    await tx
      .insertInto('vaults')
      .values({
        id,
        owner_account_id: ownerAccountId,
        name,
        settings: writeJson(VaultSettingsSchema.parse({})),
        created_at: nowIso(),
      })
      .execute()
    // `epoch` has a database default of 0; an empty vault is at sequence 0.
    await tx.insertInto('vault_seq').values({ vault_id: id, head_seq: 0 }).execute()
    await tx
      .insertInto('vault_members')
      .values({ vault_id: id, account_id: ownerAccountId, role: 'owner' })
      .execute()
  })
  return { id }
}

/** Whether an account may reach a vault: it owns the vault or holds a membership row. */
export async function isMember(
  db: Kysely<Database>,
  vaultId: string,
  accountId: string
): Promise<boolean> {
  const owned = await db
    .selectFrom('vaults')
    .select('id')
    .where('id', '=', vaultId)
    .where('owner_account_id', '=', accountId)
    .executeTakeFirst()
  if (owned) return true

  const member = await db
    .selectFrom('vault_members')
    .select('account_id')
    .where('vault_id', '=', vaultId)
    .where('account_id', '=', accountId)
    .executeTakeFirst()
  return member !== undefined
}

/** Every vault the account can reach, with its role and its usage. */
export async function listVaults(
  deps: { db: Kysely<Database> },
  accountId: string
): Promise<VaultInfo[]> {
  const rows = await deps.db
    .selectFrom('vaults')
    .leftJoin('vault_members', (join) =>
      join
        .onRef('vault_members.vault_id', '=', 'vaults.id')
        .on('vault_members.account_id', '=', accountId)
    )
    .select([
      'vaults.id as id',
      'vaults.name as name',
      'vaults.owner_account_id as owner_account_id',
      'vault_members.role as role',
    ])
    .where((eb) =>
      eb.or([
        eb('vaults.owner_account_id', '=', accountId),
        eb('vault_members.account_id', '=', accountId),
      ])
    )
    .orderBy('vaults.created_at')
    .execute()

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      // Owning a vault outranks whatever the membership row says.
      role: row.owner_account_id === accountId || row.role === 'owner' ? 'owner' : 'member',
      usage: await usage(deps.db, row.id),
    }))
  )
}

/** A vault's settings, defaults filled in. */
export async function getVaultSettings(
  deps: { db: Kysely<Database> },
  vaultId: string
): Promise<VaultSettings> {
  const row = await deps.db
    .selectFrom('vaults')
    .select('settings')
    .where('id', '=', vaultId)
    .executeTakeFirst()
  if (!row) throw new AbeleError('not_found', 'no such vault')
  return parseSettings(row.settings)
}

/**
 * What a settings patch may carry: any field, and `retention` down to a single span.
 *
 * The protocol's, re-exported rather than restated: the route parses a body with the
 * protocol's schema, and a second spelling of the same shape here is a place for the two
 * to drift apart.
 */
export type { VaultSettingsPatch }

/** Trusted in-process administration. HTTP callers must use `updateDeviceVaultSettings`. */
export async function updateVaultSettings(
  deps: { db: Kysely<Database>; dialect: Dialect },
  vaultId: string,
  patch: VaultSettingsPatch
): Promise<VaultSettings> {
  return mergeVaultSettings(deps, vaultId, patch)
}

/** A device patch: authenticate protected changes and audit every successful update atomically. */
export async function updateDeviceVaultSettings(
  deps: { db: Kysely<Database>; dialect: Dialect },
  device: DeviceIdentity,
  patch: VaultSettingsPatch,
  accountPassword?: string
): Promise<VaultSettings> {
  return mergeVaultSettings(deps, device.vaultId, patch, {
    device,
    ...(accountPassword === undefined ? {} : { accountPassword }),
  })
}

/**
 * Merge a patch into a vault's settings. `retention` merges field by field, so
 * changing one span leaves the others alone; everything else replaces wholesale.
 *
 * Read and write are one transaction under the vault's lock, so two patches cannot lose each
 * other and no commit runs against the settings half changed. A new `scripts_folder` re-kinds
 * the files already in the vault in that same transaction (`rekindScripts`): which `.js` files
 * are scripts is what the setting says. Existing versions retain their own policy classes.
 */
async function mergeVaultSettings(
  deps: { db: Kysely<Database>; dialect: Dialect },
  vaultId: string,
  patch: VaultSettingsPatch,
  proof?: SettingsProof
): Promise<VaultSettings> {
  return withVaultLock(deps.db, deps.dialect, vaultId, async (trx) => {
    const current = await getVaultSettings({ db: trx }, vaultId)
    const merged = VaultSettingsSchema.parse({
      ...current,
      ...patch,
      retention: { ...current.retention, ...patch.retention },
    })
    if (proof !== undefined) await authorizeSettingsUpdate(trx, vaultId, current, merged, proof)
    await trx
      .updateTable('vaults')
      .set({ settings: writeJson(merged) })
      .where('id', '=', vaultId)
      .execute()
    if (merged.scripts_folder !== current.scripts_folder) await rekindScripts(trx, vaultId, merged)
    return merged
  })
}

/**
 * Every `.js` file of the vault, live or in the trash, given the kind the new scripts folder
 * says it is. Only a `.js` file's kind depends on the folder (`kindOf`), so no other file is
 * looked at. This changes the live kind used by the manifest and usage, never the retention
 * class of an existing version. Scripts and attachments currently share attachments_days.
 */
async function rekindScripts(
  trx: Transaction<Database>,
  vaultId: string,
  settings: VaultSettings
): Promise<void> {
  const files = await trx
    .selectFrom('files')
    .select(['id', 'path', 'kind'])
    .where('vault_id', '=', vaultId)
    // The folded path, so `.JS` is found on every dialect.
    .where(sql<boolean>`path_ci like ${'%.js'}`)
    .execute()
  for (const file of files) {
    const kind = fileKind(file.path, settings)
    if (kind !== file.kind) {
      await trx.updateTable('files').set({ kind }).where('id', '=', file.id).execute()
    }
  }
}

/** Where a vault has got to: its head sequence, its settings and what it holds. */
export async function getState(
  deps: { db: Kysely<Database> },
  vaultId: string
): Promise<VaultState> {
  const settings = await getVaultSettings(deps, vaultId)
  const seq = await deps.db
    .selectFrom('vault_seq')
    .select('head_seq')
    .where('vault_id', '=', vaultId)
    .executeTakeFirst()
  return {
    head_seq: seq?.head_seq ?? 0,
    settings,
    usage: await usage(deps.db, vaultId),
  }
}

/**
 * Read a settings column, filling in whatever an older row was written without.
 * A row this server cannot read is the server's own fault, not the caller's, so
 * it is `internal`: the client learns nothing, and the log learns what was stored.
 */
function parseSettings(settings: string): VaultSettings {
  const parsed = VaultSettingsSchema.safeParse(readJson<unknown>(settings))
  if (!parsed.success) {
    console.error('unreadable vault settings:', parsed.error)
    throw new AbeleError('internal', 'internal error')
  }
  return parsed.data
}
