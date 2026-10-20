import {
  AbeleError,
  V2_PREVIEW_OVERLAP_LIMIT,
  type V2TokenContentPreview,
} from '@abele/sync-protocol'
import { mutation, effectiveScope, type AccessDeps } from './tokens.js'
import { covers } from './visibility.js'
import { requireItemOwner, tokenItems } from './items.js'

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
    if (!targetItems.length)
      throw new AbeleError('forbidden', 'scope_removed', { reason: 'scope_removed' })
    const files = await deps.db
      .selectFrom('files')
      .innerJoin('versions', 'versions.id', 'files.head_version_id')
      .select(['files.id as file_id', 'files.path', 'versions.size as bytes'])
      .where('files.vault_id', '=', p.space.id)
      .where('files.deleted_at', 'is', null)
      .orderBy('files.path')
      .orderBy('files.id')
      .execute()
    const loadScope = async (scopeId: string) => {
      const scope = await deps.db
        .selectFrom('access_scopes')
        .selectAll()
        .where('id', '=', scopeId)
        .where('space_id', '=', p.space.id)
        .executeTakeFirstOrThrow()
      const resolved = await effectiveScope(deps, { scope, space: p.space })
      const members = new Set(
        (
          await deps.db
            .selectFrom('scope_members')
            .select('file_id')
            .where('scope_id', '=', scopeId)
            .execute()
        ).map((row) => row.file_id)
      )
      return { scope, resolved, members }
    }
    const scopes = new Map<string, ReturnType<typeof loadScope>>()
    const getScope = (id: string) => {
      let value = scopes.get(id)
      if (!value) {
        value = loadScope(id)
        scopes.set(id, value)
      }
      return value
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
        if (item.removed_at === null) otherItems.push(item)
    const union = new Map<string, number>()
    const items: V2TokenContentPreview['items'] = []
    for (const item of targetItems) {
      const { scope, resolved, members } = await getScope(item.scope_id)
      const status =
        item.removed_at !== null ? 'removed' : resolved.active ? 'active' : 'scope_unavailable'
      const covered = []
      if (status === 'active')
        for (const file of files)
          if (members.has(file.file_id) && (await covers(deps, scope, file.path, file.file_id))) {
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
              !(await covers(deps, candidate.scope, file.path, file.file_id))
            )
              continue
            overlap_count++
            if (overlaps.length < V2_PREVIEW_OVERLAP_LIMIT)
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
