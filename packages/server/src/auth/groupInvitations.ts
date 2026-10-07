import { z } from 'zod'
import { createHash } from 'node:crypto'
import { AbeleError, credentialFacet } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { authNow, authenticateAccount } from './accounts.js'
import { withOwnerManagement, liveAt } from './freshOwner.js'
import { groupGrantRow } from './groupManagement.js'
import { withVaultLock } from '../oplog/lock.js'
import { lockAccounts } from './accountFence.js'
import { newId } from '../ids.js'
import { newToken, hashToken } from './hash.js'
import {
  request,
  futureExpiry,
  managementAudit,
  type FolderManagementDeps,
} from './folderManagementShared.js'
const id = z.string().min(1).max(200),
  role = z.enum(['reader', 'editor']),
  unavailable = () => new AbeleError('forbidden', 'group invitation or membership unavailable')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function account(deps: FolderManagementDeps, token: string) {
  if (credentialFacet(token) !== 'account')
    throw new AbeleError('unauthorized', 'an account session is required')
  return (await authenticateAccount(deps, token)).accountId
}
async function recipientRun<T>(
  deps: FolderManagementDeps,
  token: string,
  grantId: string,
  run: (
    tx: Transaction<Database>,
    accountId: string,
    grant: Awaited<ReturnType<typeof groupGrantRow>>
  ) => Promise<T>
) {
  const who = await account(deps, token),
    located = await deps.db
      .selectFrom('scope_grants')
      .select(['vault_id', 'owner_account_id'])
      .where('id', '=', grantId)
      .executeTakeFirst()
  if (!located) throw unavailable()
  return withVaultLock(
    deps.db,
    deps.dialect,
    located.vault_id,
    async (tx) => {
      if ((await account({ ...deps, db: tx }, token)) !== who) throw unavailable()
      const owner = await tx
        .selectFrom('accounts')
        .select('disabled_at')
        .where('id', '=', located.owner_account_id)
        .executeTakeFirst()
      if (!owner || owner.disabled_at !== null) throw unavailable()
      const grant = await groupGrantRow(
        tx,
        located.vault_id,
        grantId,
        deps.dialect,
        true,
        authNow(deps)
      )
      const result = await run(tx, who, grant)
      if (
        (await account({ ...deps, db: tx }, token)) !== who ||
        !liveAt(grant.expires_at, authNow(deps))
      )
        throw unavailable()
      return result
    },
    (tx) => lockAccounts(tx, [located.owner_account_id, who])
  )
}
export async function inviteGroupMember(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  grantId: string,
  input: unknown
) {
  const body = request(
    z
      .object({
        role,
        intended_account_id: id.nullable().optional(),
        expires_at: z.string().datetime(),
      })
      .strict(),
    input
  )
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const at = authNow(deps),
      grant = await groupGrantRow(tx, vaultId, grantId, deps.dialect, true, at),
      expiry = futureExpiry(body.expires_at, at)!
    if (grant.role === 'reader' && body.role === 'editor') throw unavailable()
    if (body.intended_account_id) {
      const intended = await tx
        .selectFrom('accounts')
        .select('id')
        .where('id', '=', body.intended_account_id)
        .where('disabled_at', 'is', null)
        .executeTakeFirst()
      if (!intended) throw unavailable()
    }
    const pending = await tx
      .selectFrom('scope_invitations')
      .select('id')
      .where('grant_id', '=', grantId)
      .where('revoked_at', 'is', null)
      .where('accepted_at', 'is', null)
      .where('expires_at', '>', at.toISOString())
      .limit(64)
      .execute()
    if (pending.length >= 64) throw new AbeleError('too_large', 'invitation budget reached')
    const secret = newToken('absinv'),
      invitationId = newId()
    await tx
      .insertInto('scope_invitations')
      .values({
        id: invitationId,
        grant_id: grantId,
        token_hash: hashToken(deps.pepper, secret),
        intended_account_id: body.intended_account_id ?? null,
        role: body.role,
        created_at: at.toISOString(),
        expires_at: expiry,
        revoked_at: null,
        accepted_account_id: null,
        accepted_member_id: null,
        accepted_at: null,
      })
      .execute()
    await managementAudit(
      tx,
      session.accountId,
      vaultId,
      'scope.invitation.create',
      invitationId,
      at
    )
    futureExpiry(expiry, authNow(deps))
    return { invitation_id: invitationId, invitation_token: secret, expires_at: expiry }
  })
}
export async function acceptGroupInvitation(
  deps: FolderManagementDeps,
  token: string,
  secret: string
) {
  await account(deps, token)
  if (!/^absinv_[A-Za-z0-9_-]{43}$/.test(secret)) throw unavailable()
  const digest = hashToken(deps.pepper, secret),
    located = await deps.db
      .selectFrom('scope_invitations')
      .select(['id', 'grant_id'])
      .where('token_hash', '=', digest)
      .executeTakeFirst()
  if (!located) throw unavailable()
  return recipientRun(deps, token, located.grant_id, async (tx, who, grant) => {
    let query = tx
      .selectFrom('scope_invitations')
      .selectAll()
      .where('id', '=', located.id)
      .where('grant_id', '=', grant.id)
    if (deps.dialect === 'pg') query = query.forUpdate()
    const invite = await query.executeTakeFirst(),
      at = authNow(deps)
    if (
      !invite ||
      invite.token_hash !== digest ||
      (invite.intended_account_id !== null && invite.intended_account_id !== who)
    )
      throw unavailable()
    if (invite.accepted_at !== null) {
      if (invite.accepted_account_id !== who || !invite.accepted_member_id) throw unavailable()
      const result = await tx
        .selectFrom('scope_acceptance_results')
        .selectAll()
        .where('invitation_id', '=', invite.id)
        .where('account_id', '=', who)
        .where('expires_at', '>', at.toISOString())
        .executeTakeFirst()
      const member = await tx
        .selectFrom('scope_members')
        .selectAll()
        .where('id', '=', invite.accepted_member_id)
        .where('grant_id', '=', grant.id)
        .where('account_id', '=', who)
        .executeTakeFirst()
      if (!result || !member || member.revoked_at !== null || !liveAt(member.expires_at, at))
        throw unavailable()
      return {
        grant_id: grant.id,
        member_id: member.id,
        role: grant.role === 'reader' ? ('reader' as const) : member.role,
      }
    }
    if (invite.revoked_at !== null || !liveAt(invite.expires_at, at)) throw unavailable()
    let member = await tx
      .selectFrom('scope_members')
      .selectAll()
      .where('grant_id', '=', grant.id)
      .where('account_id', '=', who)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    if (member && !liveAt(member.expires_at, at)) throw unavailable()
    if (!member) {
      const active = await tx
        .selectFrom('scope_members')
        .select('id')
        .where('grant_id', '=', grant.id)
        .where('revoked_at', 'is', null)
        .where((eb) =>
          eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())])
        )
        .limit(128)
        .execute()
      if (active.length >= 128) throw new AbeleError('too_large', 'member budget reached')
      const memberId = newId()
      await tx
        .insertInto('scope_members')
        .values({
          id: memberId,
          grant_id: grant.id,
          account_id: who,
          role: grant.role === 'reader' ? 'reader' : invite.role,
          created_at: at.toISOString(),
          expires_at: null,
          revoked_at: null,
        })
        .execute()
      member = await tx
        .selectFrom('scope_members')
        .selectAll()
        .where('id', '=', memberId)
        .executeTakeFirstOrThrow()
    }
    const consumed = await tx
      .updateTable('scope_invitations')
      .set({
        accepted_account_id: who,
        accepted_member_id: member.id,
        accepted_at: at.toISOString(),
      })
      .where('id', '=', invite.id)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    if (Number(consumed.numUpdatedRows) !== 1) throw unavailable()
    await tx
      .insertInto('scope_acceptance_results')
      .values({
        invitation_id: invite.id,
        grant_id: grant.id,
        account_id: who,
        member_id: member.id,
        request_hash: hash({ invitation: invite.id, who }),
        created_at: at.toISOString(),
        expires_at: new Date(at.getTime() + 600000).toISOString(),
      })
      .execute()
    if (!liveAt(invite.expires_at, authNow(deps))) throw unavailable()
    return { grant_id: grant.id, member_id: member.id, role: member.role }
  })
}
export async function enrolGroupInstallation(
  deps: FolderManagementDeps,
  token: string,
  grantId: string,
  input: unknown
) {
  const body = request(
    z
      .object({
        attempt_id: id,
        name: id,
        platform: z.enum(['desktop', 'mobile', 'daemon']),
        role,
        expires_at: z.string().datetime().nullable().optional(),
      })
      .strict(),
    input
  )
  return recipientRun(deps, token, grantId, async (tx, who, grant) => {
    const at = authNow(deps),
      member = await tx
        .selectFrom('scope_members')
        .selectAll()
        .where('grant_id', '=', grantId)
        .where('account_id', '=', who)
        .where('revoked_at', 'is', null)
        .executeTakeFirst()
    if (
      !member ||
      !liveAt(member.expires_at, at) ||
      (body.role === 'editor' && (grant.role === 'reader' || member.role === 'reader'))
    )
      throw unavailable()
    const expiry = futureExpiry(body.expires_at, at),
      requestHash = hash({ grantId, memberId: member.id, ...body }),
      label = `v4-group-enrol:${who}:${body.attempt_id}:${grantId}`
    const existing = await tx
      .selectFrom('scope_enrolment_results')
      .selectAll()
      .where('account_id', '=', who)
      .where('attempt_id', '=', body.attempt_id)
      .executeTakeFirst()
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new AbeleError('idempotency_mismatch', 'installation attempt changed')
      const install = await tx
        .selectFrom('scope_installations')
        .selectAll()
        .where('id', '=', existing.installation_id)
        .where('member_id', '=', member.id)
        .executeTakeFirst()
      if (
        !install ||
        install.revoked_at !== null ||
        !liveAt(install.expires_at, at) ||
        existing.retired_at !== null ||
        !liveAt(existing.expires_at, at) ||
        !existing.protected_token
      )
        throw unavailable()
      const opened = deps.store.openPart(Buffer.from(existing.protected_token, 'base64'), label)
      if (!opened || !/^absi_[A-Za-z0-9_-]{43}$/.test(opened.toString())) throw unavailable()
      if (!liveAt(install.expires_at, authNow(deps)) || !liveAt(member.expires_at, authNow(deps)))
        throw unavailable()
      return {
        installation_id: install.id,
        installation_token: opened.toString(),
        member_id: member.id,
      }
    }
    const active = await tx
      .selectFrom('scope_installations')
      .select('id')
      .where('member_id', '=', member.id)
      .where('revoked_at', 'is', null)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())]))
      .limit(64)
      .execute()
    const attempts = await tx
      .selectFrom('scope_enrolment_results')
      .select('attempt_id')
      .where('account_id', '=', who)
      .limit(128)
      .execute()
    if (active.length >= 64 || attempts.length >= 128)
      throw new AbeleError('too_large', 'installation budget reached')
    const installationId = newId(),
      secret = newToken('absi')
    await tx
      .insertInto('scope_installations')
      .values({
        id: installationId,
        grant_id: grantId,
        member_id: member.id,
        account_id: who,
        name: body.name,
        platform: body.platform,
        token_hash: hashToken(deps.pepper, secret),
        role: body.role,
        created_at: at.toISOString(),
        expires_at: expiry,
        revoked_at: null,
        last_seen_at: null,
      })
      .execute()
    const protectedToken = deps.store.sealPart(Buffer.from(secret), label).toString('base64')
    await tx
      .insertInto('scope_enrolment_results')
      .values({
        account_id: who,
        attempt_id: body.attempt_id,
        grant_id: grantId,
        member_id: member.id,
        installation_id: installationId,
        request_hash: requestHash,
        protected_token: protectedToken,
        created_at: at.toISOString(),
        expires_at: new Date(at.getTime() + 600000).toISOString(),
        retired_at: null,
      })
      .execute()
    if (!liveAt(expiry, authNow(deps)) || !liveAt(member.expires_at, authNow(deps)))
      throw unavailable()
    return { installation_id: installationId, installation_token: secret, member_id: member.id }
  })
}
export async function discoverGroupMemberships(deps: FolderManagementDeps, token: string) {
  const who = await account(deps, token),
    at = authNow(deps).toISOString()
  const rows = await deps.db
    .selectFrom('scope_members as member')
    .innerJoin('scope_grants as grant', 'grant.id', 'member.grant_id')
    .innerJoin('accounts as owner', 'owner.id', 'grant.owner_account_id')
    .select([
      'member.id as member_id',
      'grant.id as grant_id',
      'grant.vault_id',
      'grant.label',
      'grant.role',
      'grant.state',
      'grant.root_file_id',
    ])
    .where('member.account_id', '=', who)
    .where('member.revoked_at', 'is', null)
    .where('grant.revoked_at', 'is', null)
    .where('owner.disabled_at', 'is', null)
    .where('grant.selector_kind', '=', 'group')
    .where((eb) =>
      eb.and([
        eb.or([eb('member.expires_at', 'is', null), eb('member.expires_at', '>', at)]),
        eb.or([eb('grant.expires_at', 'is', null), eb('grant.expires_at', '>', at)]),
      ])
    )
    .limit(64)
    .execute()
  const safe: typeof rows = []
  for (const row of rows) {
    try {
      const current = await recipientRun(deps, token, row.grant_id, async (tx, who, grant) => {
        const member = await tx
          .selectFrom('scope_members')
          .selectAll()
          .where('id', '=', row.member_id)
          .where('grant_id', '=', grant.id)
          .where('account_id', '=', who)
          .executeTakeFirst()
        if (!member || member.revoked_at !== null || !liveAt(member.expires_at, authNow(deps)))
          throw unavailable()
        return {
          ...row,
          role: grant.role === 'reader' ? ('reader' as const) : member.role,
          state: grant.state,
          label: grant.label,
          root_file_id: grant.root_file_id,
        }
      })
      safe.push(current)
    } catch (error) {
      if (!(error instanceof AbeleError && error.code === 'forbidden')) throw error
    }
  }
  return safe
}
