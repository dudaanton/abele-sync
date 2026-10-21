import type { AccessDeps } from './tokens.js'
import type { V2Scope } from '@abele/sync-protocol'
import { isConfigurationPath } from '../configurationDirectories.js'

/** Read under the vault lock. Load graph/member data once; never query per file. */
export async function readCoverage(
  deps: AccessDeps,
  space: string,
  mode: 'content' | 'selectors' = 'content'
) {
  const rows = await deps.db
    .selectFrom('access_scopes')
    .selectAll()
    .where('space_id', '=', space)
    .execute()
  const scopes = new Map(rows.map((row) => [row.id, row]))
  const directoryRows = await deps.db
    .selectFrom('directories')
    .select(['id', 'path', 'parent_id'])
    .where('space_id', '=', space)
    .where('deleted_at', 'is', null)
    .execute()
  const directories = new Map(directoryRows.map((row) => [row.id, row]))
  const directoryPaths = new Map(directoryRows.map((row) => [row.path, row.id]))
  // Authorization needs live selectors and the graph, not heads or projections.
  // Keep the same cached inheritance/path checks in both modes.
  const fileRows =
    mode === 'selectors'
      ? (
          await deps.db
            .selectFrom('files')
            .select(['id as file_id', 'path', 'kind'])
            .where('vault_id', '=', space)
            .where('deleted_at', 'is', null)
            .execute()
        ).map((row) => ({ ...row, bytes: 0 }))
      : await deps.db
          .selectFrom('files')
          .innerJoin('versions', 'versions.id', 'files.head_version_id')
          .select(['files.id as file_id', 'files.path', 'files.kind', 'versions.size as bytes'])
          .where('files.vault_id', '=', space)
          .where('files.deleted_at', 'is', null)
          .orderBy('files.path')
          .orderBy('files.id')
          .execute()
  const fileById = new Map(fileRows.map((row) => [row.file_id, row]))
  const files = fileRows.map(({ file_id, path, bytes }) => ({ file_id, path, bytes }))
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
  const groupNotes = new Map<string, Set<string>>()
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
      groupNotes.set(root, notes)
      for (const id of notes) for (const file of attachments.get(id) ?? []) result.add(file)
      groups.set(root, result)
    }
    return result
  }
  const memberRows =
    mode === 'selectors'
      ? []
      : await deps.db
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
  const selector = (id: string): V2Scope | null => {
    const scope = scopes.get(id)
    if (!scope) return null
    if (scope.kind === 'folder') {
      const dir = directories.get(scope.target_id)
      return dir ? { kind: 'folder', id: dir.id, path: dir.path } : null
    }
    const file = fileById.get(scope.target_id)
    return file && (scope.kind !== 'group' || file.kind === 'note')
      ? { kind: scope.kind, id: file.file_id, path: file.path }
      : null
  }
  // Match contained()/effectiveScope() using this snapshot's cached selectors,
  // directory ancestry and graph closure, including inherited group-file grants.
  const contained = (child: V2Scope, parent: V2Scope) => {
    if (child.kind === parent.kind && child.id === parent.id) return true
    if (parent.kind === 'file') return false
    if (parent.kind === 'group') {
      const ids = group(parent.id)
      return child.kind === 'file'
        ? !isConfigurationPath(child.path, deps.configurationDirectories) && ids.has(child.id)
        : child.kind === 'group' && groupNotes.get(parent.id)!.has(child.id)
    }
    const slash = child.path.lastIndexOf('/')
    let id: string | undefined =
      child.kind === 'folder'
        ? child.id
        : directoryPaths.get(slash < 0 ? '/' : child.path.slice(0, slash))
    const seen = new Set<string>()
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const dir = directories.get(id)
      if (!dir) return false
      if (id === parent.id) return true
      id = dir.parent_id ?? undefined
    }
    return false
  }
  const resolve = (id: string) => {
    const scope = scopes.get(id)!
    const selected = selector(id)
    const fallback: V2Scope = { kind: scope.kind, id: scope.target_id, path: '(unavailable)' }
    if (!selected) return { scope: fallback, active: false }
    let boundary = scope.boundary_scope_id
    const seen = new Set([id])
    while (boundary !== null) {
      if (seen.has(boundary)) return { scope: fallback, active: false }
      seen.add(boundary)
      const parent = selector(boundary)
      if (!parent || !contained(selected, parent)) return { scope: fallback, active: false }
      boundary = scopes.get(boundary)!.boundary_scope_id
    }
    return { scope: selected, active: true }
  }
  const load = async (id: string) => {
    const scope = scopes.get(id)
    if (!scope) throw new Error('scope outside read snapshot')
    return {
      scope,
      resolved: resolve(id),
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
