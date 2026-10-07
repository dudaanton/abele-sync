import {
  AbeleError,
  credentialFacet,
  EnrolDeviceRequestSchema,
  type DeviceInfo,
  type EnrolDeviceResponse,
} from '@abele/sync-protocol'
import { newId } from '../ids.js'
import { isMember } from '../vault/vaults.js'
import { authNow, type AuthDeps } from './accounts.js'
import { hashToken, newToken } from './hash.js'

/** What a device token resolves to. */
export interface DeviceIdentity {
  deviceId: string
  accountId: string
  vaultId: string
  name: string
}

/** How stale `last_seen_at` may get before an authenticated call writes it again. */
const TOUCH_INTERVAL_MS = 60_000

/**
 * Enrol a device on a vault the account belongs to. The token is returned once and never stored.
 * `enrolledBy` names the device that asked for it, when one did rather than the account.
 */
export async function enrolDevice(
  deps: AuthDeps,
  accountId: string,
  vaultId: string,
  name: string,
  platform: DeviceInfo['platform'],
  enrolledBy: string | null = null
): Promise<EnrolDeviceResponse> {
  // The column is free text, so the platform is checked here rather than trusted.
  const kind = EnrolDeviceRequestSchema.shape.platform.parse(platform)
  if (!(await isMember(deps.db, vaultId, accountId))) {
    throw new AbeleError('forbidden', 'that account does not belong to this vault')
  }

  const deviceId = newId()
  const token = newToken('absd')
  await deps.db
    .insertInto('devices')
    .values({
      id: deviceId,
      account_id: accountId,
      vault_id: vaultId,
      name,
      platform: kind,
      token_hash: hashToken(deps.pepper, token),
      selective: '{}',
      created_at: authNow(deps).toISOString(),
      last_seen_at: null,
      revoked_at: null,
      enrolled_by: enrolledBy,
    })
    .execute()
  return { device_id: deviceId, device_token: token }
}

/** The account's devices that are still live, oldest first. */
export async function listDevices(deps: AuthDeps, accountId: string): Promise<DeviceInfo[]> {
  const rows = await deps.db
    .selectFrom('devices')
    .select(['id', 'name', 'platform', 'vault_id', 'last_seen_at', 'created_at', 'enrolled_by'])
    .where('account_id', '=', accountId)
    .where('revoked_at', 'is', null)
    .orderBy('created_at')
    .execute()
  return rows.map((row) => ({ ...row, platform: row.platform as DeviceInfo['platform'] }))
}

/** Revoke a device. Only the account that enrolled it can, and to anyone else it does not exist. */
export async function revokeDevice(
  deps: AuthDeps,
  accountId: string,
  deviceId: string
): Promise<void> {
  const result = await deps.db
    .updateTable('devices')
    .set({ revoked_at: authNow(deps).toISOString() })
    .where('id', '=', deviceId)
    .where('account_id', '=', accountId)
    .executeTakeFirst()
  if (result.numUpdatedRows === 0n) throw new AbeleError('not_found', 'no such device')
}

/**
 * The live devices of the asking device's account on its vault, itself included,
 * oldest first: the same rows the account's own list shows, narrowed to what one
 * device may know of — its own account, its own vault. Another account sharing the
 * vault is not listed; its devices are not this device's to see or cut off.
 */
export async function listVaultDevices(
  deps: AuthDeps,
  asking: DeviceIdentity
): Promise<DeviceInfo[]> {
  const rows = await deps.db
    .selectFrom('devices')
    .select(['id', 'name', 'platform', 'vault_id', 'last_seen_at', 'created_at', 'enrolled_by'])
    .where('account_id', '=', asking.accountId)
    .where('vault_id', '=', asking.vaultId)
    .where('revoked_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map((row) => ({ ...row, platform: row.platform as DeviceInfo['platform'] }))
}

/**
 * One device revokes another of its account on its vault. A device of another vault
 * or another account is `not_found`, as if it did not exist. One already revoked is
 * done already: the answer is the same and its revoke time stays the first one, so a
 * client that never heard the answer can ask again. The asking device itself is
 * refused — leaving goes through `DELETE /v1/devices/self`, which the client pairs
 * with forgetting its own token; a revoke from a list would leave it holding one the
 * server no longer takes.
 */
export async function revokeVaultDevice(
  deps: AuthDeps,
  asking: DeviceIdentity,
  deviceId: string
): Promise<void> {
  if (deviceId === asking.deviceId) {
    throw new AbeleError(
      'conflict',
      'a device does not revoke itself here; it leaves through DELETE /v1/devices/self'
    )
  }
  const target = await deps.db
    .selectFrom('devices')
    .select(['id', 'revoked_at'])
    .where('id', '=', deviceId)
    .where('account_id', '=', asking.accountId)
    .where('vault_id', '=', asking.vaultId)
    .executeTakeFirst()
  if (!target) throw new AbeleError('not_found', 'no such device')
  if (target.revoked_at !== null) return
  await deps.db
    .updateTable('devices')
    .set({ revoked_at: authNow(deps).toISOString() })
    .where('id', '=', deviceId)
    .where('revoked_at', 'is', null)
    .execute()
}

/**
 * Another device on the vault of the one asking, for the same account: a transfer
 * hands it to the device it sets up, so the two never share a token and either can
 * leave without cutting off the other. It reaches nothing the asking token cannot.
 */
export async function enrolSibling(
  deps: AuthDeps,
  asking: DeviceIdentity,
  name: string,
  platform: DeviceInfo['platform']
): Promise<EnrolDeviceResponse> {
  return enrolDevice(deps, asking.accountId, asking.vaultId, name, platform, asking.deviceId)
}

/**
 * A device revokes itself: its token stops working at once. Its siblings are its
 * own devices and stay. A token already revoked never gets here — the hook refuses
 * it — which is how a client tells "done now" from "done before".
 */
export async function revokeSelf(deps: AuthDeps, device: DeviceIdentity): Promise<void> {
  await deps.db
    .updateTable('devices')
    .set({ revoked_at: authNow(deps).toISOString() })
    .where('id', '=', device.deviceId)
    .where('revoked_at', 'is', null)
    .execute()
}

/**
 * Whether a device is still enrolled: not revoked. One lookup by id, for what has to ask again
 * after the token was checked — an event socket attached once its handshake is over.
 */
export async function deviceIsLive(deps: AuthDeps, deviceId: string): Promise<boolean> {
  const row = await deps.db
    .selectFrom('devices')
    .select('id')
    .where('id', '=', deviceId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  return row !== undefined
}

/** Resolve a device token. Device tokens never expire; only revoking ends one. */
export async function authenticateDevice(deps: AuthDeps, token: string): Promise<DeviceIdentity> {
  // Includes direct callers such as the WebSocket hello, which bypass HTTP auth hooks.
  if (credentialFacet(token) !== 'device')
    throw new AbeleError('unauthorized', 'invalid device token')
  const device = await deps.db
    .selectFrom('devices')
    .innerJoin('accounts', 'accounts.id', 'devices.account_id')
    .select([
      'devices.id as id',
      'devices.account_id as account_id',
      'devices.vault_id as vault_id',
      'devices.name as name',
      'devices.last_seen_at as last_seen_at',
      'devices.revoked_at as revoked_at',
      'accounts.disabled_at as disabled_at',
    ])
    .where('devices.token_hash', '=', hashToken(deps.pepper, token))
    .executeTakeFirst()
  // The join also drops a device whose account row has gone.
  if (!device || device.revoked_at !== null || device.disabled_at !== null) {
    throw new AbeleError('unauthorized', 'invalid device token')
  }

  const at = authNow(deps)
  // An unparsable timestamp counts as never seen, so a bad value is written over.
  const lastSeen = device.last_seen_at === null ? Number.NaN : Date.parse(device.last_seen_at)
  if (!Number.isFinite(lastSeen) || at.getTime() - lastSeen >= TOUCH_INTERVAL_MS) {
    await deps.db
      .updateTable('devices')
      .set({ last_seen_at: at.toISOString() })
      .where('id', '=', device.id)
      .execute()
  }

  return {
    deviceId: device.id,
    accountId: device.account_id,
    vaultId: device.vault_id,
    name: device.name,
  }
}
