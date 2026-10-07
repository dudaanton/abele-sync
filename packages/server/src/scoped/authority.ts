import { createHash } from 'node:crypto'
import {
  AbeleError,
  ScopedPrincipalSchema,
  credentialFacet,
  type ScopedPrincipal,
  type ScopedGrantSelector,
} from '@abele/sync-protocol'
import type { Kysely, Transaction } from 'kysely'
import { authNow, type AuthDeps } from '../auth/accounts.js'
import { lockAccounts } from '../auth/accountFence.js'
import { liveAt } from '../auth/freshOwner.js'
import { hashToken } from '../auth/hash.js'
import type { Dialect } from '../db/connect.js'
import type { Database } from '../db/schema.js'
import { withVaultLock } from '../oplog/lock.js'
import { registeredConfigurationDirectories } from './folderSecurity.js'

export interface ScopedDeps extends AuthDeps {
  dialect: Dialect
  configurationDirectories?: readonly string[]
  config?: { configurationDirectories?: readonly string[] }
}
export interface ScopedAuthority {
  principal: ScopedPrincipal
  ownerAccountId: string
  prefix: string
  selector: ScopedGrantSelector
  role: 'reader' | 'editor'
  state: 'preparing' | 'active'
  scopeRevision: number
  aclRevision: number
  publicationRevision: number
  digest: string
  /** Keeps feed continuity across view membership changes, not credential/ACL changes. */
  continuityDigest: string
  /** Earliest credential, member or grant deadline; checked again after awaits. */
  expiresAt: string | null
}
const invalid = (): never => {
  throw new AbeleError('unauthorized', 'scoped authority is unavailable')
}
/** Resolve only scoped facets. Account/device credentials never retry on a scoped route. */
export async function authenticateScoped(deps: AuthDeps, token: string): Promise<ScopedPrincipal> {
  if (credentialFacet(token) !== 'scoped') return invalid()
  const hash = hashToken(deps.pepper, token)
  if (token.startsWith('absk_')) {
    const row = await deps.db
      .selectFrom('scope_keys as key')
      .innerJoin('scope_grants as grant', 'grant.id', 'key.grant_id')
      .select(['key.id', 'key.owner_account_id', 'key.grant_id', 'grant.vault_id'])
      .where('key.token_hash', '=', hash)
      .executeTakeFirst()
    if (!row) return invalid()
    return ScopedPrincipalSchema.parse({
      kind: 'key',
      facet: 'scoped',
      principal_id: row.id,
      account_id: row.owner_account_id,
      grant_id: row.grant_id,
      vault_id: row.vault_id,
    })
  }
  const row = await deps.db
    .selectFrom('scope_installations as credential')
    .innerJoin('scope_grants as grant', 'grant.id', 'credential.grant_id')
    .select([
      'credential.id',
      'credential.account_id',
      'credential.member_id',
      'credential.grant_id',
      'grant.vault_id',
    ])
    .where('credential.token_hash', '=', hash)
    .executeTakeFirst()
  if (!row) return invalid()
  return ScopedPrincipalSchema.parse({
    kind: 'installation',
    facet: 'scoped',
    principal_id: row.id,
    account_id: row.account_id,
    member_id: row.member_id,
    grant_id: row.grant_id,
    vault_id: row.vault_id,
  })
}
async function authority(
  db: Kysely<Database>,
  deps: ScopedDeps,
  principal: ScopedPrincipal,
  allowUncertified = false
): Promise<ScopedAuthority> {
  const at = authNow(deps)
  const grant = await db
    .selectFrom('scope_grants')
    .selectAll()
    .where('id', '=', principal.grant_id)
    .where('vault_id', '=', principal.vault_id)
    .executeTakeFirst()
  if (!grant || grant.revoked_at !== null || !liveAt(grant.expires_at, at)) return invalid()
  const vault = await db
    .selectFrom('vaults')
    .select('owner_account_id')
    .where('id', '=', principal.vault_id)
    .executeTakeFirst()
  if (!vault || vault.owner_account_id !== grant.owner_account_id) return invalid()
  const accounts = await db
    .selectFrom('accounts')
    .innerJoin('account_authority', 'account_authority.account_id', 'accounts.id')
    .select(['accounts.id', 'accounts.disabled_at', 'account_authority.revision'])
    .where('accounts.id', 'in', [...new Set([grant.owner_account_id, principal.account_id])])
    .orderBy('accounts.id')
    .execute()
  if (
    accounts.length !== new Set([grant.owner_account_id, principal.account_id]).size ||
    accounts.some((row) => row.disabled_at !== null)
  )
    return invalid()
  let credentialRole: 'reader' | 'editor',
    credentialRevision: number,
    memberRevision: number | null = null,
    memberRole: 'reader' | 'editor' = 'editor',
    expiries = [grant.expires_at]
  if (principal.kind === 'key') {
    const key = await db
      .selectFrom('scope_keys')
      .selectAll()
      .where('id', '=', principal.principal_id)
      .where('grant_id', '=', grant.id)
      .executeTakeFirst()
    if (
      !key ||
      key.owner_account_id !== principal.account_id ||
      key.revoked_at !== null ||
      !liveAt(key.expires_at, at)
    )
      return invalid()
    expiries.push(key.expires_at)
    credentialRole = key.role
    credentialRevision = key.authority_revision
  } else {
    const member = await db
      .selectFrom('scope_members')
      .selectAll()
      .where('id', '=', principal.member_id)
      .where('grant_id', '=', grant.id)
      .where('account_id', '=', principal.account_id)
      .executeTakeFirst()
    const installation = await db
      .selectFrom('scope_installations')
      .selectAll()
      .where('id', '=', principal.principal_id)
      .where('grant_id', '=', grant.id)
      .executeTakeFirst()
    if (
      !member ||
      member.revoked_at !== null ||
      !liveAt(member.expires_at, at) ||
      !installation ||
      installation.account_id !== principal.account_id ||
      installation.member_id !== member.id ||
      installation.revoked_at !== null ||
      !liveAt(installation.expires_at, at)
    )
      return invalid()
    expiries.push(member.expires_at, installation.expires_at)
    credentialRole = installation.role
    credentialRevision = installation.authority_revision
    memberRole = member.role
    memberRevision = member.authority_revision
  }
  if (grant.state === 'unavailable')
    throw new AbeleError('scope_unavailable', 'scope authority is unavailable')
  if (
    (grant.selector_kind === 'folder' && grant.folder_prefix === null) ||
    (grant.selector_kind === 'group' && grant.root_file_id === null)
  )
    throw new AbeleError('scope_unavailable', 'scope selector is unavailable')
  let resolvedState = grant.state
  if (grant.selector_kind === 'group') {
    const progress = await db
      .selectFrom('scope_group_progress')
      .select(['processed_seq', 'status'])
      .where('vault_id', '=', principal.vault_id)
      .executeTakeFirst()
    const head = await db
      .selectFrom('vault_seq')
      .select('head_seq')
      .where('vault_id', '=', principal.vault_id)
      .executeTakeFirst()
    if (
      !progress ||
      progress.status !== 'ready' ||
      !head ||
      progress.processed_seq !== head.head_seq
    ) {
      resolvedState = 'preparing'
      if (!allowUncertified) throw new AbeleError('scope_updating', 'group view is not certified')
    }
    const root = await db
      .selectFrom('files')
      .select(['id', 'deleted_at'])
      .where('vault_id', '=', principal.vault_id)
      .where('id', '=', grant.root_file_id!)
      .executeTakeFirst()
    if (!root || root.deleted_at !== null) {
      resolvedState = 'preparing'
      if (!allowUncertified) throw new AbeleError('scope_unavailable', 'group root is unavailable')
    }
  }
  const selector: ScopedGrantSelector =
    grant.selector_kind === 'folder'
      ? { kind: 'folder', prefix: grant.folder_prefix! }
      : { kind: 'group', root_file_id: grant.root_file_id! }
  const expiresAt = expiries.filter((value): value is string => value !== null).sort()[0] ?? null
  if (!liveAt(expiresAt, authNow(deps))) return invalid()
  const role = [grant.role, credentialRole, memberRole].includes('reader') ? 'reader' : 'editor'
  const configuration = registeredConfigurationDirectories(
    deps.configurationDirectories ?? deps.config?.configurationDirectories ?? []
  )
  const continuityDigest = createHash('sha256')
    .update(
      JSON.stringify({
        configuration,
        principal,
        owner: grant.owner_account_id,
        acl: grant.acl_revision,
        selector,
        credentialRevision,
        memberRevision,
        accounts,
        role,
        prefix: grant.folder_prefix,
      })
    )
    .digest('hex')
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        configuration,
        principal,
        owner: grant.owner_account_id,
        scope: grant.scope_revision,
        acl: grant.acl_revision,
        publication: grant.publication_revision,
        selector,
        credentialRevision,
        memberRevision,
        accounts,
        role,
        prefix: grant.folder_prefix,
      })
    )
    .digest('hex')
  return {
    principal,
    ownerAccountId: grant.owner_account_id,
    prefix: grant.folder_prefix ?? '',
    selector,
    role,
    state: resolvedState,
    scopeRevision: grant.scope_revision,
    aclRevision: grant.acl_revision,
    publicationRevision: grant.publication_revision,
    digest,
    continuityDigest,
    expiresAt,
  }
}
async function lockRows(
  tx: Transaction<Database>,
  principal: ScopedPrincipal,
  dialect: Dialect
): Promise<void> {
  if (dialect !== 'pg') return
  await tx
    .selectFrom('scope_grants')
    .select('id')
    .where('id', '=', principal.grant_id)
    .forUpdate()
    .execute()
  if (principal.kind === 'installation')
    await tx
      .selectFrom('scope_members')
      .select('id')
      .where('id', '=', principal.member_id)
      .forUpdate()
      .execute()
  const table = principal.kind === 'key' ? 'scope_keys' : 'scope_installations'
  await tx
    .selectFrom(table)
    .select('id')
    .where('id', '=', principal.principal_id)
    .forUpdate()
    .execute()
}
/** Account(s) → vault → grant/member/credential → accounting. Expiry is rechecked
 * after awaited filesystem work and immediately before transaction completion.
 */
export async function withScopedAuthority<T>(
  deps: ScopedDeps,
  token: string,
  vaultId: string,
  grantId: string,
  mode: 'stage' | 'read' | 'write' | 'receipt',
  run: (tx: Transaction<Database>, checked: ScopedAuthority) => Promise<T>,
  options: { publishViewChanges?: boolean } = {}
): Promise<T> {
  const principal = await authenticateScoped(deps, token)
  if (principal.vault_id !== vaultId || principal.grant_id !== grantId) return invalid()
  const first = await authority(deps.db, deps, principal, mode === 'stage' || mode === 'receipt')
  const check = (current: ScopedAuthority) => {
    if (mode === 'write' && current.selector.kind === 'group')
      throw new AbeleError('scoped_unavailable', 'group mutation adapter is not enabled yet')
    if ((mode === 'stage' || mode === 'write') && current.role !== 'editor')
      throw new AbeleError('forbidden', 'editor authority is required')
    if ((mode === 'read' || mode === 'write') && current.state !== 'active')
      throw new AbeleError('scope_updating', 'folder view is preparing')
  }
  check(first)
  return withVaultLock(
    deps.db,
    deps.dialect,
    vaultId,
    async (tx) => {
      await lockRows(tx, principal, deps.dialect)
      const current = await authority(tx, deps, principal, mode === 'stage' || mode === 'receipt')
      check(current)
      if (
        mode === 'receipt'
          ? current.continuityDigest !== first.continuityDigest
          : current.digest !== first.digest
      )
        throw new AbeleError('scope_updating', 'authority changed; retry')
      const result = await run(tx, current)
      const final = await authority(tx, deps, principal, mode === 'stage' || mode === 'receipt')
      check(final)
      // Only the fenced scoped writer may publish its own membership transitions.
      // ACL, credentials, role, prefix and configuration remain bound identically.
      if (
        options.publishViewChanges && (mode === 'write' || mode === 'receipt')
          ? final.continuityDigest !== current.continuityDigest
          : final.digest !== current.digest
      )
        throw new AbeleError('scope_updating', 'authority changed; retry')
      // The final SQL read can itself straddle expiry; use a new clock sample
      // after the last await, immediately before transaction publication.
      if (!liveAt(final.expiresAt, authNow(deps))) return invalid()
      return result
    },
    (tx) => lockAccounts(tx, [first.ownerAccountId, principal.account_id])
  )
}
