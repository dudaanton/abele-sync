import { z } from 'zod'
import { AbeleError } from '@abele/sync-protocol'
import { sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import type { Dialect } from '../db/connect.js'
import { newId } from '../ids.js'
import { authNow } from './accounts.js'
import { withOwnerManagement, liveAt, freshOwnerSession, requireFreshOwner } from './freshOwner.js'
import {
  requireGrantSlot,
  request,
  futureExpiry,
  managementAudit,
  GRANT_FIELDS,
  type FolderManagementDeps,
} from './folderManagementShared.js'
import { versionFolderFile } from '../scoped/admissionPolicy.js'
import { scopedSecurityEligibility } from '../scoped/folderSecurity.js'
import { closeExpiredGrantIntervals } from '../scoped/admissionState.js'
import { setGroupAdmissionStart } from '../scoped/groups/grantBaseline.js'
const id = z.string().min(1).max(200),
  role = z.enum(['reader', 'editor'])
export async function groupGrantRow(
  tx: Transaction<Database>,
  vaultId: string,
  grantId: string,
  dialect: Dialect,
  live = true,
  at = new Date()
) {
  let query = tx
    .selectFrom('scope_grants')
    .selectAll()
    .where('id', '=', grantId)
    .where('vault_id', '=', vaultId)
  if (dialect === 'pg') query = query.forUpdate()
  const grant = await query.executeTakeFirst()
  if (
    !grant ||
    grant.selector_kind !== 'group' ||
    (live && (grant.revoked_at !== null || !liveAt(grant.expires_at, at)))
  )
    throw new AbeleError('forbidden', 'group authority unavailable')
  return grant
}
export async function createGroupGrant(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  input: unknown
) {
  const body = request(
    z
      .object({
        label: id,
        root_file_id: id,
        expected_root_version: id,
        role,
        expires_at: z.string().datetime().nullable().optional(),
      })
      .strict(),
    input
  )
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const at = authNow(deps),
      expiry = futureExpiry(body.expires_at, at)
    await requireGrantSlot(tx, vaultId, at)
    const file = await tx
      .selectFrom('files')
      .select(['head_version_id', 'deleted_at'])
      .where('vault_id', '=', vaultId)
      .where('id', '=', body.root_file_id)
      .executeTakeFirst()
    if (!file || file.deleted_at !== null || file.head_version_id !== body.expected_root_version)
      throw new AbeleError('conflict', 'group root preview changed')
    const root = await versionFolderFile(tx, vaultId, body.root_file_id, body.expected_root_version)
    if (
      !root ||
      root.file.kind !== 'note' ||
      !scopedSecurityEligibility(root.file, {
        configurationDirectories: deps.configurationDirectories,
      }).eligible
    )
      throw new AbeleError('settings_forbidden', 'group root is not eligible')
    const grantId = newId()
    await tx
      .insertInto('scope_grants')
      .values({
        id: grantId,
        vault_id: vaultId,
        owner_account_id: session.accountId,
        label: body.label,
        selector_kind: 'group',
        folder_prefix: null,
        root_file_id: body.root_file_id,
        role: body.role,
        state: 'preparing',
        created_at: at.toISOString(),
        expires_at: expiry,
        revoked_at: null,
        created_session_hash: session.sessionHash,
        authenticated_at: session.authenticatedAt,
      })
      .execute()
    await tx
      .insertInto('scope_feed_state')
      .values({ grant_id: grantId, updated_at: at.toISOString() })
      .execute()
    const head = await tx
      .selectFrom('vault_seq')
      .select('head_seq')
      .where('vault_id', '=', vaultId)
      .executeTakeFirstOrThrow()
    await setGroupAdmissionStart(tx, vaultId, grantId, head.head_seq, at)
    await managementAudit(tx, session.accountId, vaultId, 'scope.group.create', grantId, at)
    futureExpiry(expiry, authNow(deps))
    return tx
      .selectFrom('scope_grants')
      .select(GRANT_FIELDS)
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow()
  })
}
export async function updateGroupGrant(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  grantId: string,
  input: unknown
) {
  const body = request(
    z
      .object({
        expected_revision: z.number().int().nonnegative(),
        label: id.optional(),
        role: role.optional(),
        expires_at: z.string().datetime().nullable().optional(),
        revoke: z.boolean().optional(),
      })
      .strict(),
    input
  )
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const at = authNow(deps),
      grant = await groupGrantRow(tx, vaultId, grantId, deps.dialect, false, at)
    if (
      grant.acl_revision !== body.expected_revision ||
      (!body.revoke && grant.revoked_at !== null)
    )
      throw new AbeleError('conflict', 'group preview changed')
    const expiry = body.expires_at === undefined ? undefined : futureExpiry(body.expires_at, at)
    if (!body.revoke && expiry !== undefined && !liveAt(grant.expires_at, at))
      await requireGrantSlot(tx, vaultId, at)
    const renewed = !body.revoke && !liveAt(grant.expires_at, at)
    if (body.revoke || renewed) await closeExpiredGrantIntervals(tx, grantId, at)
    if (renewed) {
      const head = await tx
        .selectFrom('vault_seq')
        .select('head_seq')
        .where('vault_id', '=', vaultId)
        .executeTakeFirstOrThrow()
      // Renewal is audience-local. The shared worker must still replay other
      // live grants' queued departures/private gaps, not jump to this head.
      await setGroupAdmissionStart(tx, vaultId, grantId, head.head_seq, at, true)
    }
    await tx
      .updateTable('scope_grants')
      .set({
        ...(body.label ? { label: body.label } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(expiry === undefined ? {} : { expires_at: expiry }),
        ...(body.revoke
          ? { revoked_at: at.toISOString(), state: 'unavailable' as const }
          : renewed
            ? { state: 'preparing' as const }
            : {}),
        acl_revision: sql<number>`acl_revision + 1`,
      })
      .where('id', '=', grantId)
      .execute()
    await tx
      .updateTable('scope_snapshots')
      .set({ state: 'invalidated' })
      .where('grant_id', '=', grantId)
      .execute()
    await managementAudit(tx, session.accountId, vaultId, 'scope.group.update', grantId, at)
    if (!body.revoke && expiry !== undefined) futureExpiry(expiry, authNow(deps))
    return tx
      .selectFrom('scope_grants')
      .select(GRANT_FIELDS)
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow()
  })
}
export async function revokeGroupMember(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  grantId: string,
  memberId: string,
  expectedRevision: number
) {
  const session = await freshOwnerSession(deps, token)
  await requireFreshOwner(deps, session, vaultId)
  const located = await deps.db
    .selectFrom('scope_members')
    .select('account_id')
    .where('id', '=', memberId)
    .where('grant_id', '=', grantId)
    .executeTakeFirst()
  if (!located) throw new AbeleError('not_found', 'no group member')
  return withOwnerManagement(
    deps,
    token,
    vaultId,
    async (tx, session) => {
      const at = authNow(deps)
      await groupGrantRow(tx, vaultId, grantId, deps.dialect, false, at)
      const member = await tx
        .selectFrom('scope_members')
        .selectAll()
        .where('id', '=', memberId)
        .where('grant_id', '=', grantId)
        .executeTakeFirst()
      if (
        !member ||
        member.account_id !== located.account_id ||
        member.authority_revision !== expectedRevision
      )
        throw new AbeleError('conflict', 'member preview changed')
      await tx
        .updateTable('scope_members')
        .set({
          revoked_at: at.toISOString(),
          authority_revision: sql<number>`authority_revision + 1`,
        })
        .where('id', '=', memberId)
        .execute()
      const ownedInstallations = tx
        .selectFrom('scope_installations')
        .select('id')
        .where('member_id', '=', memberId)
      await tx
        .updateTable('scope_installations')
        .set({ revoked_at: at.toISOString() })
        .where('member_id', '=', memberId)
        .execute()
      await tx
        .updateTable('scope_enrolment_results')
        .set({ protected_token: null, retired_at: at.toISOString() })
        .where('member_id', '=', memberId)
        .execute()
      await tx
        .deleteFrom('scope_uploads')
        .where('principal_kind', '=', 'installation')
        .where('principal_id', 'in', ownedInstallations)
        .execute()
      await tx
        .deleteFrom('scope_blob_uploads')
        .where('principal_kind', '=', 'installation')
        .where('principal_id', 'in', ownedInstallations)
        .execute()
      await tx
        .updateTable('scope_snapshots')
        .set({ state: 'invalidated' })
        .where('principal_kind', '=', 'installation')
        .where('principal_id', 'in', ownedInstallations)
        .execute()
      await tx
        .updateTable('scope_receipts')
        .set({ response: null })
        .where('principal_kind', '=', 'installation')
        .where('principal_id', 'in', ownedInstallations)
        .execute()
      await managementAudit(tx, session.accountId, vaultId, 'scope.member.revoke', memberId, at)
      return { member_id: memberId, revoked: true }
    },
    [located.account_id]
  )
}
