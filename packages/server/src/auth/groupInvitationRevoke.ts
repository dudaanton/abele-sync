import { AbeleError } from '@abele/sync-protocol'
import { withOwnerManagement } from './freshOwner.js'
import { groupGrantRow } from './groupManagement.js'
import { authNow } from './accounts.js'
import { managementAudit, type FolderManagementDeps } from './folderManagementShared.js'
/** Redemption retirement is not membership retirement after acceptance. */
export function revokeGroupInvitation(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  grantId: string,
  invitationId: string
) {
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const at = authNow(deps)
    await groupGrantRow(tx, vaultId, grantId, deps.dialect, false, at)
    const changed = await tx
      .updateTable('scope_invitations')
      .set({ revoked_at: at.toISOString() })
      .where('id', '=', invitationId)
      .where('grant_id', '=', grantId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst()
    if (Number(changed.numUpdatedRows) > 0)
      await managementAudit(
        tx,
        session.accountId,
        vaultId,
        'scope.invitation.revoke',
        invitationId,
        at
      )
    const row = await tx
      .selectFrom('scope_invitations')
      .select('id')
      .where('id', '=', invitationId)
      .where('grant_id', '=', grantId)
      .executeTakeFirst()
    if (!row) throw new AbeleError('not_found', 'no owner invitation')
    return { invitation_id: invitationId, revoked: true }
  })
}
