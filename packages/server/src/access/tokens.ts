import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  AbeleError,
  encodeAccessToken,
  V2IssueTokenRequestSchema,
  V2AccessTokenSchema,
  VaultSettingsSchema,
  type V2Connection,
  type V2IssueTokenRequest,
  type V2IssueTokenResponse,
  type V2Scope,
  type V2TokenInfo,
  type V2Selector,
} from '@abele/sync-protocol'
import type { Kysely, Selectable } from 'kysely'
import type { Database } from '../db/schema.js'
import type { AccessScopesTable, AccessTokensTable } from '../db/schemaAccess.js'
import type { Dialect } from '../db/connect.js'
import { withVaultLock } from '../oplog/lock.js'
import { initializeScope, covers } from './visibility.js'
import { groupContains } from './groups/graph.js'

export interface AccessDeps {
  db: Kysely<Database>
  pepper: string
  dialect?: Dialect
  now?: () => Date
  configurationDirectories?: readonly string[]
}
export interface TokenPrincipal {
  token: Selectable<AccessTokensTable>
  scope: AccessScopesTable
  space: { id: string; address: string; settings: string }
}
const instant = (deps: AccessDeps): string => (deps.now?.() ?? new Date()).toISOString()
const digest = (deps: AccessDeps, key: string): string =>
  createHmac('sha256', deps.pepper).update(key).digest('hex')
const denied = () => new AbeleError('forbidden', 'this token cannot grant or revoke that access')

/** Local-only provisioning. No legacy account, membership, password or device is created. */
export async function createUser(
  deps: AccessDeps,
  label: string,
  address: string
): Promise<V2IssueTokenResponse> {
  const key = randomBytes(32).toString('base64url')
  const userId = randomUUID(),
    spaceId = randomUUID(),
    rootId = randomUUID(),
    scopeId = randomUUID()
  const value = V2AccessTokenSchema.parse({
    v: 1,
    address,
    key,
    scope: { kind: 'folder', id: rootId, path: '/' },
  })
  const request = V2IssueTokenRequestSchema.parse({ scope: { kind: 'folder', id: rootId }, label })
  const at = instant(deps)
  return deps.db.transaction().execute(async (db) => {
    await db
      .insertInto('users')
      .values({ id: userId, label: request.label, created_at: at, disabled_at: null })
      .execute()
    await db
      .insertInto('spaces')
      .values({
        id: spaceId,
        user_id: userId,
        name: request.label,
        deleted_at: null,
        address: value.address,
        settings: JSON.stringify(VaultSettingsSchema.parse({})),
        created_at: at,
      })
      .execute()
    await db.insertInto('vault_seq').values({ vault_id: spaceId, head_seq: 0 }).execute()
    await db
      .insertInto('directories')
      .values({
        id: rootId,
        space_id: spaceId,
        parent_id: null,
        path: '/',
        version_id: randomUUID(),
        mtime: Date.parse(at),
        deleted_at: null,
      })
      .execute()
    await db
      .insertInto('access_scopes')
      .values({
        id: scopeId,
        space_id: spaceId,
        kind: 'folder',
        target_id: rootId,
        boundary_scope_id: null,
        effective_key: `folder:${rootId}:root`,
      })
      .execute()
    const token: Selectable<AccessTokensTable> = {
      id: randomUUID(),
      space_id: spaceId,
      secret_hash: digest(deps, key),
      scope_id: scopeId,
      issued_by_token_id: null,
      label: request.label,
      created_at: at,
      revoked_at: null,
      scope_deleted_at: null,
      last_used_at: null,
      last_address: null,
      address_status: 'unknown',
      read_only: 0,
    }
    await db.insertInto('access_tokens').values(token).execute()
    await initializeScope(
      { ...deps, db },
      {
        id: scopeId,
        space_id: spaceId,
        kind: 'folder',
        target_id: rootId,
        boundary_scope_id: null,
        effective_key: `folder:${rootId}:root`,
      }
    )
    return { token: encodeAccessToken(value), info: info(token, value.scope) }
  })
}

/** Ordinary requests and replays require a live token. Self-deletion receipt replay is separate. */
export async function authenticateToken(deps: AccessDeps, key: string): Promise<TokenPrincipal> {
  return principalForToken(deps, await findTokenByKey(deps, key))
}

/** Secret proof only. Never authorizes content: scope-delete receipts are its sole exception. */
export async function findTokenByKey(
  deps: AccessDeps,
  key: string
): Promise<Selectable<AccessTokensTable>> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key))
    throw new AbeleError('unauthorized', 'missing or invalid access token')
  const token = await deps.db
    .selectFrom('access_tokens')
    .selectAll()
    .where('secret_hash', '=', digest(deps, key))
    .executeTakeFirst()
  if (!token) {
    const deleted = await deps.db
      .selectFrom('scope_deletions')
      .select('deleted_at')
      .where('secret_hash', '=', digest(deps, key))
      .executeTakeFirst()
    if (deleted) throw new AbeleError('scope_deleted', 'Deleted on the server')
    throw new AbeleError('unauthorized', 'access token is invalid or revoked')
  }
  return token
}

export function requireWrite(principal: TokenPrincipal): void {
  if (principal.token.read_only === 1)
    throw new AbeleError('forbidden', 'read-only tokens cannot change server content')
}

/** Internal upload ownership recheck; a public caller still authenticates the secret key. */
export async function authenticateTokenId(
  deps: AccessDeps,
  tokenId: string
): Promise<TokenPrincipal> {
  const token = await deps.db
    .selectFrom('access_tokens')
    .selectAll()
    .where('id', '=', tokenId)
    .executeTakeFirst()
  if (!token) throw new AbeleError('unauthorized', 'access token is invalid or revoked')
  return principalForToken(deps, token)
}
async function principalForToken(
  deps: AccessDeps,
  token: Selectable<AccessTokensTable>
): Promise<TokenPrincipal> {
  if (token.scope_deleted_at !== null)
    throw new AbeleError('scope_deleted', 'Deleted on the server')
  if (token.revoked_at !== null)
    throw new AbeleError('unauthorized', 'access token is invalid or revoked')
  const space = await deps.db
    .selectFrom('spaces')
    .innerJoin('users', 'users.id', 'spaces.user_id')
    .select([
      'spaces.id',
      'spaces.address',
      'spaces.settings',
      'users.disabled_at',
      'spaces.deleted_at',
    ])
    .where('spaces.id', '=', token.space_id)
    .executeTakeFirst()
  if (space === undefined || space.disabled_at !== null || space.deleted_at !== null)
    throw new AbeleError('unauthorized', 'access is disabled')
  const scope = await deps.db
    .selectFrom('access_scopes')
    .selectAll()
    .where('id', '=', token.scope_id)
    .where('space_id', '=', token.space_id)
    .executeTakeFirst()
  if (scope === undefined) throw new AbeleError('unauthorized', 'access token has no scope')
  return { token, space, scope }
}

async function selector(
  deps: AccessDeps,
  spaceId: string,
  requested: V2Selector
): Promise<V2Scope | null> {
  if (requested.kind === 'folder') {
    const node = await deps.db
      .selectFrom('directories')
      .select(['id', 'path'])
      .where('id', '=', requested.id)
      .where('space_id', '=', spaceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    return node === undefined ? null : { kind: 'folder', id: node.id, path: node.path }
  }
  const note = await deps.db
    .selectFrom('files')
    .select(['id', 'path'])
    .where('id', '=', requested.id)
    .where('vault_id', '=', spaceId)
    .where('kind', '=', 'note')
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return note === undefined ? null : { kind: 'group', id: note.id, path: note.path }
}

/** Stable directory ancestry and indexed group reachability, not a credential chain. */
async function contained(
  deps: AccessDeps,
  space: string,
  child: V2Scope,
  parent: V2Scope
): Promise<boolean> {
  if (child.kind === parent.kind && child.id === parent.id) return true
  if (parent.kind === 'group')
    return child.kind === 'group' && (await groupContains(deps, space, parent.id, child.id))
  let nodeId: string | undefined
  if (child.kind === 'folder') nodeId = child.id
  else {
    const slash = child.path.lastIndexOf('/')
    const folderPath = slash === -1 ? '/' : child.path.slice(0, slash)
    nodeId = (
      await deps.db
        .selectFrom('directories')
        .select('id')
        .where('space_id', '=', space)
        .where('path', '=', folderPath)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()
    )?.id
  }
  const seen = new Set<string>()
  while (nodeId !== undefined) {
    if (seen.has(nodeId)) return false
    seen.add(nodeId)
    const node = await deps.db
      .selectFrom('directories')
      .select(['id', 'parent_id'])
      .where('id', '=', nodeId)
      .where('space_id', '=', space)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (node === undefined) return false
    if (node.id === parent.id) return true
    nodeId = node.parent_id ?? undefined
  }
  return false
}

export async function effectiveScope(
  deps: AccessDeps,
  principal: Pick<TokenPrincipal, 'scope'> & { space: { id: string } }
): Promise<{ scope: V2Scope; active: boolean }> {
  const scope = await selector(deps, principal.space.id, {
    kind: principal.scope.kind,
    id: principal.scope.target_id,
  })
  const fallback: V2Scope = {
    kind: principal.scope.kind,
    id: principal.scope.target_id,
    path: '(unavailable)',
  }
  if (scope === null) return { scope: fallback, active: false }
  let boundaryId = principal.scope.boundary_scope_id
  const seen = new Set<string>([principal.scope.id])
  while (boundaryId !== null) {
    if (seen.has(boundaryId)) return { scope: fallback, active: false }
    seen.add(boundaryId)
    const boundary = await deps.db
      .selectFrom('access_scopes')
      .selectAll()
      .where('id', '=', boundaryId)
      .where('space_id', '=', principal.space.id)
      .executeTakeFirst()
    if (boundary === undefined) return { scope: fallback, active: false }
    const current = await selector(deps, principal.space.id, {
      kind: boundary.kind,
      id: boundary.target_id,
    })
    if (current === null || !(await contained(deps, principal.space.id, scope, current)))
      return { scope: fallback, active: false }
    boundaryId = boundary.boundary_scope_id
  }
  return { scope, active: true }
}

export async function connection(
  deps: AccessDeps,
  principal: TokenPrincipal
): Promise<V2Connection> {
  const resolved = await effectiveScope(deps, principal)
  const settings = VaultSettingsSchema.parse(JSON.parse(principal.space.settings))
  return {
    protocol: 2,
    token_id: principal.token.id,
    read_only: principal.token.read_only === 1,
    space_id: principal.space.id,
    scope: resolved.scope,
    status: !resolved.active ? 'scope_unavailable' : 'active',
    limits: { max_file_bytes: settings.max_file_bytes, quota_bytes: settings.quota_bytes },
  }
}
export async function rootAuthority(deps: AccessDeps, principal: TokenPrincipal): Promise<boolean> {
  const resolved = await effectiveScope(deps, principal)
  if (!resolved.active || resolved.scope.kind !== 'folder') return false
  const node = await deps.db
    .selectFrom('directories')
    .select(['parent_id', 'path'])
    .where('id', '=', resolved.scope.id)
    .where('space_id', '=', principal.space.id)
    .executeTakeFirst()
  return node?.parent_id === null && node.path === '/'
}

/** Serialize management writes per space on PG, then reauthenticate under that lock. */
async function mutation<T>(
  deps: AccessDeps,
  key: string,
  run: (deps: AccessDeps, principal: TokenPrincipal) => Promise<T>
): Promise<T> {
  const initial = await authenticateToken(deps, key)
  return withVaultLock(deps.db, deps.dialect ?? 'sqlite', initial.space.id, async (db) => {
    if (deps.dialect === 'pg')
      await db
        .selectFrom('spaces')
        .select('id')
        .where('id', '=', initial.space.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
    const transactional = { ...deps, db }
    return run(transactional, await authenticateToken(transactional, key))
  })
}
export async function issueToken(
  deps: AccessDeps,
  key: string,
  input: V2IssueTokenRequest
): Promise<V2IssueTokenResponse> {
  const request = V2IssueTokenRequestSchema.parse(input)
  return mutation(deps, key, (deps, principal) => issueFromPrincipal(deps, principal, request))
}

/** Internal issuance: callers own the space lock and establish the principal's authority. */
export async function issueFromPrincipal(
  deps: AccessDeps,
  principal: TokenPrincipal,
  input: V2IssueTokenRequest
): Promise<V2IssueTokenResponse> {
  const request = V2IssueTokenRequestSchema.parse(input)
  const current = await effectiveScope(deps, principal)
  if (!current.active)
    throw new AbeleError('scope_unavailable', 'this scope or its inherited boundary is unavailable')
  const requested = await selector(deps, principal.space.id, request.scope)
  if (requested === null || !(await contained(deps, principal.space.id, requested, current.scope)))
    throw denied()
  const same = requested.kind === current.scope.kind && requested.id === current.scope.id
  const proposed = same
    ? principal.scope
    : {
        id: randomUUID(),
        space_id: principal.space.id,
        kind: requested.kind,
        target_id: requested.id,
        boundary_scope_id: principal.scope.id,
        effective_key: '(proposed)',
      }
  // Validate all inherited selectors before writing cache/token rows or returning
  // the display path. Immediate group reachability alone may include private notes.
  if (
    !(await effectiveScope(deps, { scope: proposed, space: principal.space })).active ||
    (requested.kind === 'group' &&
      !(await covers(deps, principal.scope, requested.path, requested.id)))
  )
    throw denied()
  let scope = principal.scope
  let freshScope = false
  if (requested.kind !== current.scope.kind || requested.id !== current.scope.id) {
    const effectiveKey = `${requested.kind}:${requested.id}:${principal.scope.id}`
    const inserted = await deps.db
      .insertInto('access_scopes')
      .values({
        id: randomUUID(),
        space_id: principal.space.id,
        kind: requested.kind,
        target_id: requested.id,
        boundary_scope_id: principal.scope.id,
        effective_key: effectiveKey,
      })
      .onConflict((oc) => oc.columns(['space_id', 'effective_key']).doNothing())
      .returning('id')
      .executeTakeFirst()
    freshScope = inserted !== undefined
    scope = await deps.db
      .selectFrom('access_scopes')
      .selectAll()
      .where('space_id', '=', principal.space.id)
      .where('effective_key', '=', effectiveKey)
      .executeTakeFirstOrThrow()
  }
  if (freshScope) await initializeScope(deps, scope)
  const secret = randomBytes(32).toString('base64url')
  const token: Selectable<AccessTokensTable> = {
    id: randomUUID(),
    space_id: principal.space.id,
    secret_hash: digest(deps, secret),
    scope_id: scope.id,
    issued_by_token_id: principal.token.id,
    label: request.label,
    created_at: instant(deps),
    revoked_at: null,
    scope_deleted_at: null,
    last_used_at: null,
    last_address: null,
    address_status: 'unknown',
    read_only: principal.token.read_only === 1 || request.read_only ? 1 : 0,
  }
  await deps.db.insertInto('access_tokens').values(token).execute()
  return {
    token: encodeAccessToken({
      v: 1,
      address: principal.space.address,
      key: secret,
      scope: requested,
    }),
    info: info(token, requested),
  }
}

export async function listTokens(deps: AccessDeps, key: string): Promise<V2TokenInfo[]> {
  // Serialize selector/path reads with graph and directory mutations, too.
  return mutation(deps, key, listedTokens)
}
async function listedTokens(deps: AccessDeps, principal: TokenPrincipal): Promise<V2TokenInfo[]> {
  const root = await rootAuthority(deps, principal)
  let query = deps.db
    .selectFrom('access_tokens')
    .selectAll()
    .where('space_id', '=', principal.space.id)
  if (!root) query = query.where('issued_by_token_id', '=', principal.token.id)
  const tokens = await query.orderBy('created_at').orderBy('id').execute()
  const caller = await effectiveScope(deps, principal)
  const result: V2TokenInfo[] = []
  for (const token of tokens) {
    const scope = await deps.db
      .selectFrom('access_scopes')
      .selectAll()
      .where('id', '=', token.scope_id)
      .where('space_id', '=', principal.space.id)
      .executeTakeFirstOrThrow()
    const resolved = await selector(deps, principal.space.id, {
      kind: scope.kind,
      id: scope.target_id,
    })
    const visible =
      resolved !== null &&
      (root ||
        (caller.active &&
          (await effectiveScope(deps, { scope, space: principal.space })).active &&
          (await contained(deps, principal.space.id, resolved, caller.scope)) &&
          (resolved.kind !== 'group' ||
            (await covers(deps, principal.scope, resolved.path, resolved.id)))))
    // Direct issuers retain credential metadata for cleanup, never an escaped target's path.
    if (!root && !visible && token.issued_by_token_id !== principal.token.id) continue
    result.push(
      info(
        token,
        visible ? resolved! : { kind: scope.kind, id: scope.target_id, path: '(unavailable)' }
      )
    )
  }
  return result
}
export async function revokeToken(deps: AccessDeps, key: string, tokenId: string): Promise<void> {
  return mutation(deps, key, async (deps, principal) => {
    const target = await deps.db
      .selectFrom('access_tokens')
      .selectAll()
      .where('id', '=', tokenId)
      .where('space_id', '=', principal.space.id)
      .executeTakeFirst()
    if (
      target === undefined ||
      (target.issued_by_token_id !== principal.token.id && !(await rootAuthority(deps, principal)))
    )
      throw denied()
    // Revocation only removes access: an issuer may clean up its own direct grants
    // even after their selectors leave its boundary. Other issuers' grants require root.
    // Direct revocation only. The immutable scope boundary is not an issuer's credential.
    await deps.db
      .updateTable('access_tokens')
      .set({ revoked_at: instant(deps) })
      .where('id', '=', target.id)
      .where('revoked_at', 'is', null)
      .execute()
  })
}
function info(token: Selectable<AccessTokensTable>, scope: V2Scope): V2TokenInfo {
  return {
    id: token.id,
    scope,
    label: token.label,
    issued_by_token_id: token.issued_by_token_id,
    created_at: token.created_at,
    revoked_at: token.revoked_at,
    read_only: token.read_only === 1,
  }
}
