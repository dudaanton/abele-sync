import { AbeleError } from '@abele/sync-protocol'
import { authenticateScoped, type ScopedDeps } from './authority.js'
import { withVaultLock } from '../oplog/lock.js'
import { lockAccounts } from '../auth/accountFence.js'
import { authNow } from '../auth/accounts.js'
import { newId } from '../ids.js'
/** Credential possession permits only its own retirement, including expired/revoked
 * recovery. This metadata-only operation never bypasses a content authority check.
 */
export async function revokeScopedSelf(
  deps: ScopedDeps,
  token: string,
  vaultId: string,
  grantId: string
): Promise<{ revoked: true }> {
  const first = await authenticateScoped(deps, token)
  if (first.vault_id !== vaultId || first.grant_id !== grantId)
    throw new AbeleError('unauthorized', 'scoped identity mismatch')
  const vault = await deps.db
    .selectFrom('vaults')
    .select('owner_account_id')
    .where('id', '=', vaultId)
    .executeTakeFirst()
  if (!vault) throw new AbeleError('unauthorized', 'scoped identity unavailable')
  return withVaultLock(
    deps.db,
    deps.dialect,
    vaultId,
    async (tx) => {
      const principal = await authenticateScoped({ ...deps, db: tx }, token)
      if (
        principal.principal_id !== first.principal_id ||
        principal.kind !== first.kind ||
        principal.grant_id !== grantId ||
        principal.vault_id !== vaultId
      )
        throw new AbeleError('unauthorized', 'scoped identity changed')
      let grant = tx
        .selectFrom('scope_grants')
        .select('id')
        .where('id', '=', grantId)
        .where('vault_id', '=', vaultId)
      if (deps.dialect === 'pg') grant = grant.forUpdate()
      if (!(await grant.executeTakeFirst()))
        throw new AbeleError('unauthorized', 'scoped identity unavailable')
      const at = authNow(deps).toISOString()
      let changed = false
      if (principal.kind === 'key') {
        const result = await tx
          .updateTable('scope_keys')
          .set({ revoked_at: at })
          .where('id', '=', principal.principal_id)
          .where('grant_id', '=', grantId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst()
        changed = Number(result.numUpdatedRows) > 0
        await tx
          .updateTable('scope_key_issuances')
          .set({ protected_token: null, retired_at: at })
          .where('key_id', '=', principal.principal_id)
          .execute()
      } else {
        const result = await tx
          .updateTable('scope_installations')
          .set({ revoked_at: at })
          .where('id', '=', principal.principal_id)
          .where('grant_id', '=', grantId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst()
        changed = Number(result.numUpdatedRows) > 0
      }
      await tx
        .deleteFrom('scope_uploads')
        .where('principal_kind', '=', principal.kind)
        .where('principal_id', '=', principal.principal_id)
        .where('grant_id', '=', grantId)
        .execute()
      await tx
        .deleteFrom('scope_blob_uploads')
        .where('principal_kind', '=', principal.kind)
        .where('principal_id', '=', principal.principal_id)
        .where('grant_id', '=', grantId)
        .execute()
      await tx
        .updateTable('scope_snapshots')
        .set({ state: 'invalidated' })
        .where('principal_kind', '=', principal.kind)
        .where('principal_id', '=', principal.principal_id)
        .where('grant_id', '=', grantId)
        .execute()
      await tx
        .updateTable('scope_receipts')
        .set({ response: null })
        .where('principal_kind', '=', principal.kind)
        .where('principal_id', '=', principal.principal_id)
        .where('grant_id', '=', grantId)
        .execute()
      if (changed)
        await tx
          .insertInto('audit')
          .values({
            id: newId(),
            vault_id: vaultId,
            actor_kind: 'key',
            actor_id: principal.principal_id,
            action: 'scope.self.revoke',
            path: null,
            result: 'revoked',
            at,
            details: '{}',
          })
          .execute()
      return { revoked: true as const }
    },
    (tx) => lockAccounts(tx, [vault.owner_account_id, first.account_id])
  )
}
