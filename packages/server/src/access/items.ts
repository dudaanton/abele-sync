import { randomUUID } from 'node:crypto'
import { AbeleError, type V2Selector } from '@abele/sync-protocol'
import type { Selectable } from 'kysely'
import { sql } from 'kysely'
import type { AccessTokensTable } from '../db/schemaAccess.js'
import { covers } from './visibility.js'
import {
  mutation,
  effectiveScope,
  rootAuthority,
  grantScope,
  contained,
  authenticateTokenForInventory,
  authenticateToken,
  type AccessDeps,
  type TokenPrincipal,
} from './tokens.js'

const removed = () => new AbeleError('forbidden', 'scope_removed', { reason: 'scope_removed' })
const at = (deps: AccessDeps) => (deps.now?.() ?? new Date()).toISOString()

/** Legacy primary items have a stable, reserved id and need no backfill. */
export const primaryItemId = (tokenId: string) => `primary:${tokenId}`
export async function tokenItems(deps: AccessDeps, token: Selectable<AccessTokensTable>) {
  const rows = await deps.db
    .selectFrom('access_token_items')
    .selectAll()
    .where('token_id', '=', token.id)
    .orderBy('added_at')
    .orderBy('id')
    .execute()
  if (!rows.some((row) => row.id === primaryItemId(token.id)))
    rows.unshift({
      id: primaryItemId(token.id),
      token_id: token.id,
      scope_id: token.scope_id,
      added_by_token_id: token.issued_by_token_id,
      added_at: token.created_at,
      removed_at: null,
    })
  return rows
}
export async function resolveTokenItem(
  deps: AccessDeps,
  token: Selectable<AccessTokensTable>,
  id?: string
) {
  const row = (await tokenItems(deps, token)).find(
    (row) => row.id === (id ?? primaryItemId(token.id))
  )
  if (!row || row.removed_at !== null) throw removed()
  return row
}
export async function listItems(deps: AccessDeps, key: string, tokenId?: string) {
  return mutation(
    deps,
    key,
    async (deps, p) => {
      const items = []
      const token = tokenId === undefined ? p.token : await requireItemOwner(deps, p, tokenId)
      const callerScopes = tokenId === undefined ? [] : await callerItemScopes(deps, p)
      const root = tokenId !== undefined && (await rootAuthority(deps, p))
      for (const row of await tokenItems(deps, token)) {
        const scope = await deps.db
          .selectFrom('access_scopes')
          .selectAll()
          .where('id', '=', row.scope_id)
          .executeTakeFirstOrThrow()
        const current = await effectiveScope(deps, { scope, space: p.space })
        if (tokenId !== undefined && !root) {
          let visible = false
          if (current.active)
            for (const caller of callerScopes)
              if (await covers(deps, caller, current.scope.path, current.scope.id)) {
                visible = true
                break
              }
          if (!visible) continue
        }
        const resolved =
          row.removed_at === null
            ? current
            : { scope: { kind: scope.kind, id: scope.target_id, path: '(unavailable)' } }
        items.push({
          id: row.id,
          scope_id: row.scope_id,
          scope: resolved.scope,
          added_at: row.added_at,
          removed_at: row.removed_at,
        })
      }
      return { items }
    },
    tokenId === undefined ? authenticateTokenForInventory : authenticateToken
  )
}
/** Explicit headers restrict content to that item; otherwise use the key's live item union. */
export async function callerItemScopes(deps: AccessDeps, p: TokenPrincipal) {
  if (deps.itemId !== undefined) return [p.scope]
  const ids = (await tokenItems(deps, p.token))
    .filter((item) => item.removed_at === null)
    .map((item) => item.scope_id)
  return deps.db
    .selectFrom('access_scopes')
    .selectAll()
    .where('space_id', '=', p.space.id)
    .where('id', 'in', ids)
    .execute()
}
/** Whole-vault counts use one grouped query; scoped counts apply inventory visibility. */
export async function itemCounts(
  deps: AccessDeps,
  tokenIds: string[],
  key?: string
): Promise<Map<string, number>> {
  if (!tokenIds.length) return new Map<string, number>()
  if (key !== undefined)
    return mutation(deps, key, async (deps, p) => {
      if (await rootAuthority(deps, p)) return itemCounts(deps, tokenIds)
      const callerScopes = await callerItemScopes(deps, p)
      const counts = new Map(tokenIds.map((id) => [id, 0]))
      const tokens = await deps.db
        .selectFrom('access_tokens')
        .selectAll()
        .where('space_id', '=', p.space.id)
        .where('issued_by_token_id', '=', p.token.id)
        .where('id', 'in', tokenIds)
        .execute()
      for (const token of tokens)
        for (const item of await tokenItems(deps, token)) {
          if (item.removed_at !== null) continue
          const scope = await deps.db
            .selectFrom('access_scopes')
            .selectAll()
            .where('id', '=', item.scope_id)
            .executeTakeFirstOrThrow()
          const current = await effectiveScope(deps, { scope, space: p.space })
          if (!current.active) continue
          for (const caller of callerScopes)
            if (await covers(deps, caller, current.scope.path, current.scope.id)) {
              counts.set(token.id, counts.get(token.id)! + 1)
              break
            }
        }
      return counts
    })
  const rows = await deps.db
    .selectFrom('access_token_items')
    .select([
      'token_id',
      sql<number>`sum(case when removed_at is null then 1 else 0 end)`.as('live_count'),
      sql<number>`max(case when id = 'primary:' || token_id then 1 else 0 end)`.as('has_primary'),
    ])
    .where('token_id', 'in', tokenIds)
    .groupBy('token_id')
    .execute()
  const counts = new Map(tokenIds.map((id) => [id, 1]))
  for (const row of rows)
    counts.set(row.token_id, Number(row.live_count) + (Number(row.has_primary) ? 0 : 1))
  return counts
}
export async function requireItemOwner(deps: AccessDeps, p: TokenPrincipal, targetId: string) {
  const target = await deps.db
    .selectFrom('access_tokens')
    .selectAll()
    .where('id', '=', targetId)
    .where('space_id', '=', p.space.id)
    .executeTakeFirst()
  if (!target || (target.issued_by_token_id !== p.token.id && !(await wholeVaultKey(deps, p))))
    throw new AbeleError('forbidden', 'only the issuer or whole-vault key may edit items')
  return target
}
async function wholeVaultKey(deps: AccessDeps, p: TokenPrincipal) {
  if (await rootAuthority(deps, p)) return true
  if (p.scope.id === p.token.scope_id) return false
  // A selected group/file limits content, but does not change the identity of a
  // whole-vault management key. A detached primary never supplies this authority.
  try {
    const primary = await resolveTokenItem(deps, p.token)
    const scope = await deps.db
      .selectFrom('access_scopes')
      .selectAll()
      .where('id', '=', primary.scope_id)
      .where('space_id', '=', p.space.id)
      .executeTakeFirstOrThrow()
    return rootAuthority(deps, { ...p, scope })
  } catch (error) {
    if (error instanceof AbeleError && error.code === 'forbidden') return false
    throw error
  }
}
/** Owner decision gate: recipients cannot delete shared content through an item. */
export async function requireOwnerForItemServerDelete(
  deps: AccessDeps,
  p: TokenPrincipal,
  targetId = p.token.id
) {
  return requireItemOwner(deps, p, targetId)
}
export async function addItem(
  deps: AccessDeps,
  key: string,
  tokenId: string,
  selector: V2Selector
) {
  return mutation(deps, key, async (deps, p) => {
    const target = await requireItemOwner(deps, p, tokenId)
    if (target.revoked_at !== null) throw new AbeleError('forbidden', 'token is revoked')
    const { scope, requested } = await grantScope(deps, p, selector)
    const absorbed: string[] = []
    for (const row of await tokenItems(deps, target)) {
      if (row.removed_at) continue
      const existing = await deps.db
        .selectFrom('access_scopes')
        .selectAll()
        .where('id', '=', row.scope_id)
        .executeTakeFirstOrThrow()
      const resolved = await effectiveScope(deps, { scope: existing, space: p.space })
      if (
        (existing.kind === selector.kind && existing.target_id === selector.id) ||
        (existing.kind === 'folder' &&
          requested.kind !== 'group' &&
          resolved.active &&
          (await contained(deps, p.space.id, requested, resolved.scope)))
      )
        throw new AbeleError('forbidden', 'item is already shared or covered by a folder')
      // Group membership may extend beyond its root's folder, so groups remain
      // independent even when that root lies inside the new folder.
      if (
        requested.kind === 'folder' &&
        existing.kind !== 'group' &&
        resolved.active &&
        (await contained(deps, p.space.id, resolved.scope, requested))
      )
        absorbed.push(row.id)
    }
    const row = {
      id: randomUUID(),
      token_id: target.id,
      scope_id: scope.id,
      added_by_token_id: p.token.id,
      added_at: at(deps),
      removed_at: null,
    }
    await deps.db.insertInto('access_token_items').values(row).execute()
    for (const id of absorbed) await detachItem(deps, target, id)
    if (p.token.read_only === 1)
      await deps.db
        .updateTable('access_tokens')
        .set({ read_only: 1 })
        .where('id', '=', target.id)
        .execute()
    return {
      id: row.id,
      scope_id: row.scope_id,
      scope: requested,
      added_at: row.added_at,
      removed_at: null,
    }
  })
}
export async function detachItem(
  deps: AccessDeps,
  token: Selectable<AccessTokensTable>,
  id: string
) {
  const row = await resolveTokenItem(deps, token, id)
  await deps.db
    .insertInto('access_token_items')
    .values({ ...row, removed_at: at(deps) })
    .onConflict((oc) => oc.column('id').doUpdateSet({ removed_at: at(deps) }))
    .execute()
}
export async function removeItem(deps: AccessDeps, key: string, tokenId: string, id: string) {
  return mutation(deps, key, async (deps, p) => {
    const target = await requireItemOwner(deps, p, tokenId)
    await detachItem(deps, target, id)
    return { removed: true as const }
  })
}
