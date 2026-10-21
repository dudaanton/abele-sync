import {
  AbeleError,
  V2_PREVIEW_OVERLAP_LIMIT,
  type V2TokenContentPreview,
} from '@abele/sync-protocol'
import { mutation, rootAuthority, selector, type AccessDeps } from './tokens.js'
import { covers } from './visibility.js'
import { requireItemOwner, tokenItems, callerItemScopes } from './items.js'
import { readCoverage } from './readCoverage.js'

/** A single vault-serialized snapshot of live heads and current inherited membership.
 * This is information for confirmation, never a grant or a deletion receipt.
 */
export async function previewTokenContent(
  deps: AccessDeps,
  key: string,
  tokenId: string,
  limit: number,
  itemId?: string
): Promise<V2TokenContentPreview> {
  return mutation(deps, key, async (deps, p) => {
    const target = await requireItemOwner(deps, p, tokenId)
    const targetItems = (await tokenItems(deps, target)).filter(
      (item) => itemId === undefined || item.id === itemId
    )
    const callerScopes = await callerItemScopes(deps, p)
    const root = await rootAuthority(deps, p)
    const forbidden = () =>
      new AbeleError('forbidden', 'scope_removed', { reason: 'scope_removed' })
    if (!targetItems.length) throw forbidden()
    // Direct-item denial must precede bulk graph/member reads and enumeration.
    // Whole-token reads retain snapshot-based filtering for many-item sets.
    if (itemId !== undefined && !root) {
      const scope = await deps.db
        .selectFrom('access_scopes')
        .selectAll()
        .where('id', '=', targetItems[0]!.scope_id)
        .where('space_id', '=', p.space.id)
        .executeTakeFirstOrThrow()
      // Do not walk the target's inherited bounds just to reject a selector
      // the caller cannot cover. Accepted selectors are rechecked in the snapshot.
      const selected = await selector(deps, p.space.id, { kind: scope.kind, id: scope.target_id })
      let visible = false
      if (selected !== null)
        for (const caller of callerScopes)
          if (await covers(deps, caller, selected.path, selected.id)) {
            visible = true
            break
          }
      if (!visible) throw forbidden()
    }
    const snapshot = await readCoverage(deps, p.space.id)
    const { files, context: getScope } = snapshot
    const callerCovers = async (path: string, id: string) => {
      for (const scope of callerScopes) if (await snapshot.covers(scope.id, path, id)) return true
      return false
    }
    // Include implicit primary items too. Revoked keys and detached items cannot
    // supply live overlap; orphaned scope rows are not access grants.
    const otherItems = []
    for (const token of await deps.db
      .selectFrom('access_tokens')
      .selectAll()
      .where('space_id', '=', p.space.id)
      .where('revoked_at', 'is', null)
      .orderBy('id')
      .execute())
      for (const item of await tokenItems(deps, token))
        if (item.removed_at === null)
          otherItems.push({
            ...item,
            discloseToken:
              root || token.id === p.token.id || token.issued_by_token_id === p.token.id,
          })
    const union = new Map<string, number>()
    const items: V2TokenContentPreview['items'] = []
    for (const item of targetItems) {
      const { scope, resolved, members } = await getScope(item.scope_id)
      if (
        !root &&
        (!resolved.active || !(await callerCovers(resolved.scope.path, resolved.scope.id)))
      ) {
        if (itemId !== undefined)
          throw new AbeleError('forbidden', 'scope_removed', { reason: 'scope_removed' })
        continue
      }
      const status =
        item.removed_at !== null ? 'removed' : resolved.active ? 'active' : 'scope_unavailable'
      const covered = []
      if (status === 'active')
        for (const file of files)
          if (
            members.has(file.file_id) &&
            (await snapshot.covers(scope.id, file.path, file.file_id)) &&
            (await callerCovers(file.path, file.file_id))
          ) {
            covered.push(file)
            union.set(file.file_id, Number(file.bytes))
          }
      const listed = []
      for (const file of covered.slice(0, limit)) {
        const overlaps = []
        let overlap_count = 0
        if (scope.kind === 'group')
          for (const other of otherItems) {
            if (other.token_id === target.id && other.id === item.id) continue
            const candidate = await getScope(other.scope_id)
            if (
              !candidate.resolved.active ||
              !candidate.members.has(file.file_id) ||
              !(await snapshot.covers(candidate.scope.id, file.path, file.file_id))
            )
              continue
            overlap_count++
            if (
              overlaps.length < V2_PREVIEW_OVERLAP_LIMIT &&
              other.discloseToken &&
              (await callerCovers(candidate.resolved.scope.path, candidate.resolved.scope.id))
            )
              overlaps.push({
                token_id: other.token_id,
                item_id: other.id,
                scope_id: other.scope_id,
                scope: candidate.resolved.scope,
              })
          }
        listed.push({ ...file, bytes: Number(file.bytes), overlaps, overlap_count })
      }
      items.push({
        id: item.id,
        scope_id: item.scope_id,
        scope:
          status === 'removed'
            ? { kind: scope.kind, id: scope.target_id, path: '(unavailable)' }
            : resolved.scope,
        added_at: item.added_at,
        removed_at: item.removed_at,
        status,
        file_count: covered.length,
        total_bytes: covered.reduce((sum, file) => sum + Number(file.bytes), 0),
        files: listed,
      })
    }
    return {
      token_id: target.id,
      file_count: union.size,
      total_bytes: [...union.values()].reduce((sum, bytes) => sum + bytes, 0),
      items,
    }
  })
}
