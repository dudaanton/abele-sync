import { AbeleError, credentialFacet } from '@abele/sync-protocol'
import { sql, type Transaction } from 'kysely'
import type { Dialect } from '../db/connect.js'
import type { Database } from '../db/schema.js'
import { withVaultLock } from '../oplog/lock.js'
import { lockAccounts } from './accountFence.js'
import { authNow, type AuthDeps } from './accounts.js'
import { hashToken } from './hash.js'

export interface OwnerSession {
  readonly accountId: string
  readonly sessionHash: string
  readonly authenticatedAt: string
}
export interface OwnerManagementDeps extends AuthDeps {
  dialect: Dialect
}
export const OWNER_FRESH_MS = 5 * 60 * 1000

/** Authenticated issuance time, not an owner-shaped membership or caller-supplied identity. */
export async function freshOwnerSession(deps: AuthDeps, token: string): Promise<OwnerSession> {
  if (credentialFacet(token) !== 'account')
    throw new AbeleError('unauthorized', 'a fresh account session is required')
  const sessionHash = hashToken(deps.pepper, token)
  const row = await deps.db
    .selectFrom('account_tokens')
    .select(['account_id', 'issued_at'])
    .where('token_hash', '=', sessionHash)
    .executeTakeFirst()
  if (!row) throw new AbeleError('unauthorized', 'a fresh account session is required')
  const session = Object.freeze({
    accountId: row.account_id,
    sessionHash,
    authenticatedAt: row.issued_at ?? '',
  })
  await checkSession(deps, session)
  return session
}
async function checkSession(deps: AuthDeps, session: OwnerSession): Promise<void> {
  const row = await deps.db
    .selectFrom('account_tokens')
    .innerJoin('accounts', 'accounts.id', 'account_tokens.account_id')
    .innerJoin('account_authority', 'account_authority.account_id', 'accounts.id')
    .select([
      'account_tokens.account_id',
      'account_tokens.issued_at',
      'account_tokens.expires_at',
      'accounts.disabled_at',
    ])
    .where('token_hash', '=', session.sessionHash)
    .executeTakeFirst()
  const at = authNow(deps).getTime(),
    issued = row?.issued_at ? Date.parse(row.issued_at) : NaN
  if (
    !row ||
    row.account_id !== session.accountId ||
    row.issued_at !== session.authenticatedAt ||
    row.disabled_at !== null ||
    !Number.isFinite(issued) ||
    issued > at ||
    at - issued >= OWNER_FRESH_MS ||
    !Number.isFinite(Date.parse(row.expires_at)) ||
    Date.parse(row.expires_at) <= at
  ) {
    throw new AbeleError('unauthorized', 'a fresh account session is required')
  }
}
export async function requireFreshOwner(
  deps: AuthDeps,
  session: OwnerSession,
  vaultId: string
): Promise<void> {
  await checkSession(deps, session)
  const vault = await deps.db
    .selectFrom('vaults')
    .select('owner_account_id')
    .where('id', '=', vaultId)
    .executeTakeFirst()
  if (!vault || vault.owner_account_id !== session.accountId)
    throw new AbeleError('forbidden', 'the actual vault owner is required')
}
/** Shared account → vault → owner/grant/key rows. Recheck after awaited publication work. */
export async function withOwnerManagement<T>(
  deps: OwnerManagementDeps,
  token: string,
  vaultId: string,
  publish: (tx: Transaction<Database>, session: OwnerSession) => Promise<T>,
  otherAccounts: readonly string[] = []
): Promise<T> {
  const session = await freshOwnerSession(deps, token)
  return withVaultLock(
    deps.db,
    deps.dialect,
    vaultId,
    async (tx) => {
      if (deps.dialect === 'pg')
        await tx.selectFrom('vaults').select('id').where('id', '=', vaultId).forUpdate().execute()
      const bound = { ...deps, db: tx }
      await requireFreshOwner(bound, session, vaultId)
      const result = await publish(tx, session)
      await requireFreshOwner(bound, session, vaultId)
      return result
    },
    (tx) => lockAccounts(tx, [session.accountId, ...otherAccounts])
  )
}
/** Enforces a real row lock after the vault lock on PG; the enclosing tx serializes SQLite. */
export async function ownerGrant(
  tx: Transaction<Database>,
  vaultId: string,
  grantId: string,
  dialect: Dialect,
  selector: 'folder' | 'group' | 'any' = 'folder'
) {
  let query = tx
    .selectFrom('scope_grants')
    .selectAll()
    .where('id', '=', grantId)
    .where('vault_id', '=', vaultId)
  if (dialect === 'pg') query = query.forUpdate()
  const grant = await query.executeTakeFirst()
  if (!grant || (selector !== 'any' && grant.selector_kind !== selector))
    throw new AbeleError('not_found', 'no folder grant')
  return grant
}
export const liveAt = (expires: string | null, at: Date) =>
  expires === null || (Number.isFinite(Date.parse(expires)) && Date.parse(expires) > at.getTime())
export const activeFirst = (at: Date) =>
  sql<number>`case when revoked_at is null and (expires_at is null or expires_at > ${at.toISOString()}) then 0 else 1 end`
