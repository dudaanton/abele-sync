import { AbeleError, type VaultSettings } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import { verifyAccountPassword } from '../auth/accounts.js'
import type { DeviceIdentity } from '../auth/devices.js'
import { writeJson } from '../db/json.js'
import type { Database } from '../db/schema.js'
import { newId, nowIso } from '../ids.js'

/** Only the HTTP auth hook supplies the device identity; password proof is request-local. */
export interface SettingsProof {
  device: DeviceIdentity
  accountPassword?: string
}

/**
 * Check and audit under the same vault lock as the settings read/write. Comparing outside
 * that lock would let a concurrent patch evade proof by comparing against stale values.
 * A failure later in the update rolls this audit row back too; no password is ever recorded.
 */
export async function authorizeSettingsUpdate(
  tx: Transaction<Database>,
  vaultId: string,
  before: VaultSettings,
  after: VaultSettings,
  proof: SettingsProof
): Promise<void> {
  const { device, accountPassword } = proof
  if (device.vaultId !== vaultId)
    throw new AbeleError('forbidden', 'that device belongs to another vault')
  const changesHistory = Object.keys(before.retention).some((key) => {
    const span = key as keyof VaultSettings['retention']
    return after.retention[span] !== before.retention[span]
  })
  const changesQuota = after.quota_bytes !== before.quota_bytes
  if (accountPassword === undefined) {
    if (changesHistory || changesQuota) {
      throw new AbeleError(
        'account_password_required',
        'the account password is required for every retention or quota change'
      )
    }
  } else {
    // Supplying a password is a claim of account authentication, even on a safe patch.
    await verifyAccountPassword({ db: tx }, device.accountId, accountPassword)
  }
  await tx
    .insertInto('audit')
    .values({
      id: newId(),
      vault_id: vaultId,
      actor_kind: accountPassword === undefined ? 'device' : 'account',
      actor_id: accountPassword === undefined ? device.deviceId : device.accountId,
      action: 'vault.settings.update',
      path: null,
      result: 'applied',
      at: nowIso(),
      details: writeJson({ device_id: device.deviceId, before, after }),
    })
    .execute()
}
