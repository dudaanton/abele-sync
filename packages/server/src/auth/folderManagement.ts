import {
  AbeleError,
  CreateFolderGrantRequestSchema,
  UpdateFolderGrantRequestSchema,
} from '@abele/sync-protocol'
import { sql } from 'kysely'
import { newId } from '../ids.js'
import { configurationPath } from '../scoped/folderSecurity.js'
import { closeExpiredGrantIntervals } from '../scoped/admissionState.js'
import { authNow } from './accounts.js'
import { activeFirst, liveAt, ownerGrant, withOwnerManagement } from './freshOwner.js'
import {
  GRANT_FIELDS,
  futureExpiry,
  managementAudit,
  request,
  requireGrantSlot,
  type FolderManagementDeps,
} from './folderManagementShared.js'
export { issueFolderKey, listFolderKeys, updateFolderKey } from './folderKeys.js'
export type { FolderManagementDeps } from './folderManagementShared.js'

/** Creates only a dormant folder authority; group parsing/admission is not a dependency. */
export async function createFolderGrant(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  input: unknown
) {
  const body = request(CreateFolderGrantRequestSchema, input)
  if (configurationPath(body.prefix, deps))
    throw new AbeleError('settings_forbidden', 'configuration namespaces cannot be granted')
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const at = authNow(deps),
      expires = futureExpiry(body.expires_at, at)
    await requireGrantSlot(tx, vaultId, at)
    const id = newId()
    await tx
      .insertInto('scope_grants')
      .values({
        id,
        vault_id: vaultId,
        owner_account_id: session.accountId,
        label: body.label,
        selector_kind: 'folder',
        folder_prefix: body.prefix,
        root_file_id: null,
        role: body.role,
        state: 'preparing',
        created_at: at.toISOString(),
        expires_at: expires,
        revoked_at: null,
        created_session_hash: session.sessionHash,
        authenticated_at: session.authenticatedAt,
      })
      .execute()
    await tx
      .insertInto('scope_feed_state')
      .values({ grant_id: id, updated_at: at.toISOString() })
      .execute()
    await managementAudit(tx, session.accountId, vaultId, 'scope.grant.create', id, at)
    futureExpiry(expires, authNow(deps))
    return tx
      .selectFrom('scope_grants')
      .select(GRANT_FIELDS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  })
}
export async function listOwnerGrants(deps: FolderManagementDeps, token: string, vaultId: string) {
  return withOwnerManagement(deps, token, vaultId, (tx) =>
    tx
      .selectFrom('scope_grants')
      .select(GRANT_FIELDS)
      .where('vault_id', '=', vaultId)
      .where('selector_kind', '=', 'folder')
      .orderBy(activeFirst(authNow(deps)))
      .orderBy('created_at')
      .orderBy('id')
      .limit(64)
      .execute()
  )
}
export async function updateFolderGrant(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  grantId: string,
  input: unknown
) {
  const body = request(UpdateFolderGrantRequestSchema, input)
  if (body.prefix !== undefined && configurationPath(body.prefix, deps))
    throw new AbeleError('settings_forbidden', 'configuration namespaces cannot be granted')
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const grant = await ownerGrant(tx, vaultId, grantId, deps.dialect),
      at = authNow(deps)
    if (grant.acl_revision !== body.expected_revision)
      throw new AbeleError('conflict', 'grant preview changed')
    if (!body.revoke && grant.revoked_at !== null)
      throw new AbeleError('conflict', 'grant is retired')
    const expiry = body.expires_at === undefined ? undefined : futureExpiry(body.expires_at, at)
    if (!body.revoke && expiry !== undefined && !liveAt(grant.expires_at, at))
      await requireGrantSlot(tx, vaultId, at)
    const authorityChanged =
      (body.prefix !== undefined && body.prefix !== grant.folder_prefix) ||
      (body.role !== undefined && body.role !== grant.role) ||
      (expiry !== undefined && expiry !== grant.expires_at) ||
      body.revoke ||
      body.rebuild === true
    const newBaseline =
      !body.revoke &&
      (body.rebuild === true ||
        !liveAt(grant.expires_at, at) ||
        (body.prefix !== undefined && body.prefix !== grant.folder_prefix) ||
        (body.role !== undefined && body.role !== grant.role))
    if (newBaseline) {
      await closeExpiredGrantIntervals(tx, grantId, at)
      // Only a fresh reviewed owner mutation resets interrupted preparation.
      await tx.deleteFrom('scope_folder_preparations').where('grant_id', '=', grantId).execute()
    }
    await tx
      .updateTable('scope_grants')
      .set({
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.prefix === undefined ? {} : { folder_prefix: body.prefix }),
        ...(body.role === undefined ? {} : { role: body.role }),
        ...(expiry === undefined ? {} : { expires_at: expiry }),
        ...(body.revoke
          ? { revoked_at: grant.revoked_at ?? at.toISOString(), state: 'unavailable' as const }
          : newBaseline
            ? { state: 'preparing' as const }
            : {}),
        acl_revision: sql<number>`acl_revision + 1`,
        ...(authorityChanged ? { scope_revision: sql<number>`scope_revision + 1` } : {}),
      })
      .where('id', '=', grantId)
      .execute()
    await tx
      .updateTable('scope_snapshots')
      .set({ state: 'invalidated' })
      .where('grant_id', '=', grantId)
      .execute()
    if (body.revoke)
      await tx
        .updateTable('scope_key_issuances')
        .set({ protected_token: null, retired_at: at.toISOString() })
        .where('grant_id', '=', grantId)
        .execute()
    await managementAudit(
      tx,
      session.accountId,
      vaultId,
      body.revoke ? 'scope.grant.revoke' : 'scope.grant.update',
      grantId,
      at
    )
    if (!body.revoke && expiry !== undefined) futureExpiry(expiry, authNow(deps))
    return tx
      .selectFrom('scope_grants')
      .select(GRANT_FIELDS)
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow()
  })
}
