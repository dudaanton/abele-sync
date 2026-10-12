import {
  AbeleError,
  V2ManifestItemSchema,
  type V2ManifestItem,
  type V2Change,
} from '@abele/sync-protocol'
import type { Kysely, Selectable } from 'kysely'
import type { Database, VersionsTable } from '../db/schema.js'
import type { AccessScopesTable } from '../db/schemaAccess.js'
import { effectiveScope, type AccessDeps, type TokenPrincipal } from './tokens.js'
import { isConfigurationPath } from '../configurationDirectories.js'
import { closure, initializeGroup, deletedGroupContains } from './groups/graph.js'

export async function folderWasDeleted(
  deps: AccessDeps,
  scope: AccessScopesTable
): Promise<boolean> {
  if (scope.kind !== 'folder') return false
  return (
    (await deps.db
      .selectFrom('directories')
      .select('id')
      .where('space_id', '=', scope.space_id)
      .where('id', '=', scope.target_id)
      .where('deleted_at', 'is not', null)
      .executeTakeFirst()) !== undefined
  )
}

export async function activeScope(deps: AccessDeps, principal: TokenPrincipal) {
  const resolved = await effectiveScope(deps, principal)
  if (!resolved.active)
    throw new AbeleError('scope_unavailable', 'this scope or inherited boundary is unavailable')
  return resolved.scope
}
export async function covers(
  deps: AccessDeps & { configurationDirectories?: readonly string[] },
  scope: AccessScopesTable,
  path: string,
  fileId?: string
): Promise<boolean> {
  const resolved = await effectiveScope(deps, { scope, space: { id: scope.space_id } })
  if (!resolved.active) return false
  if (resolved.scope.kind === 'group') {
    if (!(await groupPathAllowed(deps, scope, path))) return false
    let query = deps.db
      .selectFrom('files')
      .select(['id', 'deleted_at'])
      .where('vault_id', '=', scope.space_id)
      .where('path', '=', path)
    if (fileId) query = query.where('id', '=', fileId)
    const file = await query.executeTakeFirst()
    if (!file) return false
    const ids = await closure(deps, scope.space_id, scope.target_id)
    if (
      ids.has(file.id) ||
      (file.deleted_at &&
        (await deletedGroupContains(deps, scope.space_id, scope.target_id, file.id)))
    )
      return true
    for (const id of ids) {
      if (
        await deps.db
          .selectFrom('group_assets')
          .select('file_id')
          .where('space_id', '=', scope.space_id)
          .where('root_id', '=', id)
          .where('file_id', '=', file.id)
          .executeTakeFirst()
      )
        return true
      if (
        await deps.db
          .selectFrom('group_copies')
          .select('file_id')
          .where('space_id', '=', scope.space_id)
          .where('original_id', '=', id)
          .where('file_id', '=', file.id)
          .executeTakeFirst()
      )
        return true
    }
    return false
  }
  const prefix = resolved.scope.path
  return (
    prefix === '/' ||
    (!isConfigurationPath(path, deps.configurationDirectories) &&
      (path === prefix || path.startsWith(prefix + '/')))
  )
}
/** Placement inside a group is path-preserving, but inherited selectors still bound it. */
export async function groupPathAllowed(
  deps: AccessDeps,
  scope: AccessScopesTable,
  path: string
): Promise<boolean> {
  if (isConfigurationPath(path, deps.configurationDirectories)) return false
  if (!scope.boundary_scope_id) return true
  const boundary = await deps.db
    .selectFrom('access_scopes')
    .selectAll()
    .where('id', '=', scope.boundary_scope_id)
    .executeTakeFirstOrThrow()
  return boundary.kind === 'group'
    ? groupPathAllowed(deps, boundary, path)
    : covers(deps, boundary, path)
}
export async function members(db: Kysely<Database>, scopeId: string): Promise<V2ManifestItem[]> {
  const rows = await db
    .selectFrom('scope_members')
    .select('item')
    .where('scope_id', '=', scopeId)
    .execute()
  return rows.map((row) => V2ManifestItemSchema.parse(JSON.parse(row.item)))
}
export async function member(
  db: Kysely<Database>,
  scopeId: string,
  fileId: string
): Promise<V2ManifestItem | undefined> {
  const row = await db
    .selectFrom('scope_members')
    .select('item')
    .where('scope_id', '=', scopeId)
    .where('file_id', '=', fileId)
    .executeTakeFirst()
  return row ? V2ManifestItemSchema.parse(JSON.parse(row.item)) : undefined
}
export async function versionVisible(
  db: Kysely<Database>,
  scopeId: string,
  fileId: string,
  versionId: string
) {
  return (
    (await db
      .selectFrom('scope_versions')
      .select('version_id')
      .where('scope_id', '=', scopeId)
      .where('file_id', '=', fileId)
      .where('version_id', '=', versionId)
      .executeTakeFirst()) !== undefined
  )
}
/** Deleted files remain accessible only when both their tombstone and content were visible.
 * A file that departed is not history authority, even if an older version was shared. */
export async function historyAuthority(deps: AccessDeps, p: TokenPrincipal, fileId: string) {
  const current = await member(deps.db, p.scope.id, fileId)
  if (
    current &&
    current.kind !== 'directory' &&
    (await covers(deps, p.scope, current.path, fileId))
  )
    return
  const file = await deps.db
    .selectFrom('files')
    .select(['path', 'head_version_id', 'deleted_at'])
    .where('id', '=', fileId)
    .where('vault_id', '=', p.space.id)
    .executeTakeFirst()
  if (
    !file?.deleted_at ||
    !file.head_version_id ||
    !(await covers(deps, p.scope, file.path, fileId)) ||
    !(await versionVisible(deps.db, p.scope.id, fileId, file.head_version_id))
  )
    throw new AbeleError('not_found', 'no file in this scope')
}
export async function remember(db: Kysely<Database>, scopeId: string, item: V2ManifestItem) {
  await db
    .insertInto('scope_members')
    .values({ scope_id: scopeId, file_id: item.file_id, item: JSON.stringify(item) })
    .onConflict((oc) =>
      oc.columns(['scope_id', 'file_id']).doUpdateSet({ item: JSON.stringify(item) })
    )
    .execute()
  await db
    .insertInto('scope_versions')
    .values({ scope_id: scopeId, file_id: item.file_id, version_id: item.version_id })
    .onConflict((oc) => oc.columns(['scope_id', 'version_id']).doNothing())
    .execute()
}
export async function initializeScope(deps: AccessDeps, scope: AccessScopesTable) {
  if (scope.kind === 'group') return initializeGroup(deps, scope)
  const files = await deps.db
    .selectFrom('files')
    .innerJoin('versions', 'versions.id', 'files.head_version_id')
    .select([
      'files.id',
      'files.kind',
      'versions.path',
      'versions.id as version_id',
      'versions.blob_sha',
      'versions.size',
      'versions.mtime',
    ])
    .where('files.vault_id', '=', scope.space_id)
    .where('files.deleted_at', 'is', null)
    .execute()
  for (const file of files)
    if (file.blob_sha && (await covers(deps, scope, file.path)))
      await remember(deps.db, scope.id, {
        file_id: file.id,
        version_id: file.version_id,
        path: file.path,
        kind: file.kind,
        sha: file.blob_sha,
        size: file.size,
        mtime: file.mtime,
      })
  const dirs = await deps.db
    .selectFrom('directories')
    .selectAll()
    .where('space_id', '=', scope.space_id)
    .where('deleted_at', 'is', null)
    .execute()
  for (const dir of dirs)
    if (dir.path !== '/' && (await covers(deps, scope, dir.path)))
      await remember(deps.db, scope.id, {
        file_id: dir.id,
        version_id: dir.version_id,
        path: dir.path,
        kind: 'directory',
        mtime: dir.mtime,
      })
}

/** One durable event per engine/directory version, per effective selector.
 * Membership facts and content/leave/delete events are committed with the engine write. */
export async function recordItem(
  deps: AccessDeps & { configurationDirectories?: readonly string[] },
  spaceId: string,
  item: V2ManifestItem,
  cursor: number,
  at: string,
  deleted: boolean
) {
  const scopes = await deps.db
    .selectFrom('access_scopes')
    .selectAll()
    .where('space_id', '=', spaceId)
    .execute()
  for (const scope of scopes) {
    // Losing authority (revocation, escaped boundaries, deleted group roots) is not
    // deletion. A genuinely deleted directory is different: its formerly visible
    // items produce final delete events, without authorizing any new content.
    const resolved = await effectiveScope(deps, { scope, space: { id: spaceId } })
    if (resolved.scope.kind !== 'folder') continue
    if (!resolved.active && !(deleted && (await folderWasDeleted(deps, scope)))) continue
    const old = await member(deps.db, scope.id, item.file_id)
    const visible = item.path !== '/' && (await covers(deps, scope, item.path))
    let event: V2Change | undefined
    if (deleted && old) {
      event = {
        type: 'delete',
        cursor,
        at,
        file_id: item.file_id,
        path: old.path,
        version_id: item.version_id,
      }
      await deps.db
        .insertInto('scope_versions')
        .values({ scope_id: scope.id, file_id: item.file_id, version_id: item.version_id })
        .onConflict((oc) => oc.columns(['scope_id', 'version_id']).doNothing())
        .execute()
    } else if (!deleted && visible) {
      event = {
        type: 'content',
        cursor,
        at,
        file_id: item.file_id,
        path: item.path,
        item,
        prev_path: old && old.path !== item.path ? old.path : null,
      }
      await remember(deps.db, scope.id, item)
    } else if (old) event = { type: 'removal', cursor, at, file_id: item.file_id, path: old.path }
    if (!event) continue
    if (event.type !== 'content')
      await deps.db
        .deleteFrom('scope_members')
        .where('scope_id', '=', scope.id)
        .where('file_id', '=', item.file_id)
        .execute()
    await deps.db
      .insertInto('scope_changes')
      .values({ scope_id: scope.id, cursor, type: event.type, event: JSON.stringify(event) })
      .execute()
  }
}
export async function recordFileVersion(
  deps: AccessDeps & { configurationDirectories?: readonly string[] },
  v: Selectable<VersionsTable>,
  kind: Database['files']['kind']
) {
  // Deletes have no blob; wire delete events don't expose a fictitious content item.
  const item = {
    file_id: v.file_id,
    version_id: v.id,
    path: v.path,
    kind,
    sha: v.blob_sha ?? '0'.repeat(64),
    size: v.size,
    mtime: v.mtime,
  }
  await recordItem(deps, v.vault_id, item, v.seq, v.created_at, v.op === 'delete')
}
