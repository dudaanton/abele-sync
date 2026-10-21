import { effectiveScope, type AccessDeps } from './tokens.js'
import { isConfigurationPath } from '../configurationDirectories.js'

/** Read under the vault lock. Load graph/member data once; never query per file. */
export async function readCoverage(deps: AccessDeps, space: string) {
  const rows = await deps.db
    .selectFrom('access_scopes')
    .selectAll()
    .where('space_id', '=', space)
    .execute()
  const scopes = new Map(rows.map((row) => [row.id, row]))
  const files = await deps.db
    .selectFrom('files')
    .innerJoin('versions', 'versions.id', 'files.head_version_id')
    .select(['files.id as file_id', 'files.path', 'versions.size as bytes'])
    .where('files.vault_id', '=', space)
    .where('files.deleted_at', 'is', null)
    .orderBy('files.path')
    .orderBy('files.id')
    .execute()
  const live = new Set(files.map((file) => file.file_id))
  const edges = await deps.db
    .selectFrom('group_links')
    .innerJoin('group_notes', 'group_notes.file_id', 'group_links.source_id')
    .innerJoin('files', 'files.id', 'group_links.source_id')
    .select(['source_id', 'target_id'])
    .where('group_links.space_id', '=', space)
    .where('group_notes.space_id', '=', space)
    .where('files.vault_id', '=', space)
    .where('files.kind', '=', 'note')
    .where('files.deleted_at', 'is', null)
    .execute()
  const children = new Map<string, string[]>()
  for (const edge of edges)
    if (edge.target_id) {
      const list = children.get(edge.target_id) ?? []
      list.push(edge.source_id)
      children.set(edge.target_id, list)
    }
  const attachments = new Map<string, Set<string>>()
  const assets = await deps.db
    .selectFrom('group_assets')
    .select(['root_id', 'file_id'])
    .where('space_id', '=', space)
    .execute()
  const copies = await deps.db
    .selectFrom('group_copies')
    .select(['original_id as root_id', 'file_id'])
    .where('space_id', '=', space)
    .execute()
  for (const row of [...assets, ...copies]) {
    const set = attachments.get(row.root_id) ?? new Set<string>()
    set.add(row.file_id)
    attachments.set(row.root_id, set)
  }
  const groups = new Map<string, Set<string>>()
  const group = (root: string) => {
    let result = groups.get(root)
    if (!result) {
      const notes = new Set<string>(),
        queue = [root]
      while (queue.length) {
        const id = queue.pop()!
        if (notes.has(id)) continue
        notes.add(id)
        queue.push(...(children.get(id) ?? []))
      }
      result = new Set(notes)
      for (const id of notes) for (const file of attachments.get(id) ?? []) result.add(file)
      groups.set(root, result)
    }
    return result
  }
  const memberRows = await deps.db
    .selectFrom('scope_members')
    .innerJoin('access_scopes', 'access_scopes.id', 'scope_members.scope_id')
    .select(['scope_id', 'file_id'])
    .where('access_scopes.space_id', '=', space)
    .execute()
  const members = new Map<string, Set<string>>()
  for (const row of memberRows) {
    const set = members.get(row.scope_id) ?? new Set<string>()
    set.add(row.file_id)
    members.set(row.scope_id, set)
  }
  const load = async (id: string) => {
    const scope = scopes.get(id)
    if (!scope) throw new Error('scope outside read snapshot')
    return {
      scope,
      resolved: await effectiveScope(deps, { scope, space: { id: space } }),
      members: members.get(id) ?? new Set<string>(),
    }
  }
  const contexts = new Map<string, ReturnType<typeof load>>()
  const context = (id: string) => {
    let value = contexts.get(id)
    if (!value) {
      value = load(id)
      contexts.set(id, value)
    }
    return value
  }
  const pathAllowed = async (
    id: string,
    path: string,
    file: string,
    seen: Set<string>
  ): Promise<boolean> => {
    if (seen.has(id) || isConfigurationPath(path, deps.configurationDirectories)) return false
    const scope = scopes.get(id)!
    if (!scope.boundary_scope_id) return true
    const boundary = scopes.get(scope.boundary_scope_id)
    if (!boundary) return false
    const next = new Set(seen).add(id)
    return boundary.kind === 'group'
      ? pathAllowed(boundary.id, path, file, next)
      : covers(boundary.id, path, file, next)
  }
  const covers = async (
    id: string,
    path: string,
    file: string,
    seen = new Set<string>()
  ): Promise<boolean> => {
    if (seen.has(id)) return false
    const { scope, resolved } = await context(id)
    if (!resolved.active) return false
    if (scope.kind === 'folder')
      return (
        resolved.scope.path === '/' ||
        (!isConfigurationPath(path, deps.configurationDirectories) &&
          (path === resolved.scope.path || path.startsWith(resolved.scope.path + '/')))
      )
    if (scope.kind === 'group')
      return live.has(file) && group(scope.target_id).has(file) && pathAllowed(id, path, file, seen)
    if (scope.target_id !== file || !live.has(file)) return false
    if (!scope.boundary_scope_id) return true
    const boundary = scopes.get(scope.boundary_scope_id)
    if (!boundary) return false
    const next = new Set(seen).add(id)
    return boundary.kind === 'group'
      ? pathAllowed(boundary.id, path, file, next)
      : covers(boundary.id, path, file, next)
  }
  return { files, context, covers }
}
