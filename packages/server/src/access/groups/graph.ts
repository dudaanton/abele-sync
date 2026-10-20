import { sql, type Selectable } from 'kysely'
import {
  AbeleError,
  groupLinkKey,
  parseGroupFrontmatter,
  type V2Change,
  type V2ManifestItem,
} from '@abele/sync-protocol'
import type { BlobStore } from '../../blobs/store.js'
import type { AccessDeps } from '../tokens.js'
import type { AccessScopesTable } from '../../db/schemaAccess.js'
import type { VersionsTable } from '../../db/schema.js'
import { effectiveScope } from '../tokens.js'
import { groupPathAllowed, members, remember, refreshFileScopes } from '../visibility.js'
import { isConfigurationPath } from '../../configurationDirectories.js'

const unique = (values: Iterable<string>) => [...new Set(values)]

/** The parser permits 64 KiB of YAML; include its delimiters, never the note body. */
async function frontmatter(store: BlobStore, sha: string): Promise<string> {
  const length = Math.min(await store.size(sha), 65552)
  if (length === 0) return ''
  const stream = await store.openRange(sha, 0, length - 1)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const value of stream) {
      const chunk = value as Buffer
      size += chunk.length
      if (size > length) throw new AbeleError('internal', 'frontmatter range exceeded its bound')
      chunks.push(chunk)
    }
    if (size !== length) throw new AbeleError('internal', 'frontmatter range was truncated')
    return Buffer.concat(chunks, size).toString('utf8')
  } finally {
    stream.destroy()
  }
}
export async function ancestors(
  deps: AccessDeps,
  space: string,
  sources: Iterable<string>,
  liveOnly = false
) {
  const seen = new Set<string>(),
    queue = unique(sources)
  while (queue.length) {
    const id = queue.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    let query = deps.db
      .selectFrom('group_links')
      .select('target_id')
      .where('space_id', '=', space)
      .where('source_id', '=', id)
    if (liveOnly)
      query = query.where(
        'source_id',
        'in',
        deps.db
          .selectFrom('group_notes')
          .innerJoin('files', 'files.id', 'group_notes.file_id')
          .select('group_notes.file_id')
          .where('group_notes.space_id', '=', space)
          .where('files.vault_id', '=', space)
          .where('files.kind', '=', 'note')
          .where('files.deleted_at', 'is', null)
      )
    const edges = await query.execute()
    for (const edge of edges)
      if (edge.target_id && !seen.has(edge.target_id)) queue.push(edge.target_id)
  }
  return seen
}
export async function groupContains(deps: AccessDeps, space: string, root: string, fileId: string) {
  return (await ancestors(deps, space, [fileId], true)).has(root)
}
/** A trashed target may retain its own outgoing bindings; every subsequent hop
 * must be a live group note. Archived chains never authorize descendant restores. */
export async function deletedGroupContains(
  deps: AccessDeps,
  space: string,
  root: string,
  fileId: string
) {
  const edges = await deps.db
    .selectFrom('group_links')
    .select('target_id')
    .where('space_id', '=', space)
    .where('source_id', '=', fileId)
    .execute()
  for (const edge of edges)
    if (edge.target_id && (await groupContains(deps, space, root, edge.target_id))) return true
  return false
}
export async function closure(deps: AccessDeps, space: string, root: string) {
  const seen = new Set<string>(),
    queue = [root]
  while (queue.length) {
    const id = queue.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const edges = await deps.db
      .selectFrom('group_links')
      .innerJoin('group_notes', 'group_notes.file_id', 'group_links.source_id')
      .innerJoin('files', 'files.id', 'group_links.source_id')
      .select('source_id')
      .where('group_links.space_id', '=', space)
      .where('group_notes.space_id', '=', space)
      .where('files.vault_id', '=', space)
      .where('files.kind', '=', 'note')
      .where('files.deleted_at', 'is', null)
      .where('target_id', '=', id)
      .execute()
    for (const edge of edges) queue.push(edge.source_id)
  }
  return seen
}
async function resolve(deps: AccessDeps, space: string, key: string) {
  // Indexed exact path / unique suffix, matching the shared portable resolver.
  const rows = await deps.db
    .selectFrom('group_names')
    .select(['file_id', 'exact'])
    .where('space_id', '=', space)
    .where('name', '=', key)
    .execute()
  const exact = rows.filter((row) => row.exact === 1)
  const candidates = exact.length ? exact : rows
  return candidates.length === 1 ? candidates[0]!.file_id : null
}
const spellingsOf = (path: string) => {
  const parts = path.replace(/\.md$/i, '').normalize('NFC').toLowerCase().split('/')
  return parts.map((_, i) => parts.slice(i).join('/'))
}
async function resolvePending(
  deps: AccessDeps,
  space: string,
  spellings: string[],
  affected: Set<string>
) {
  if (!spellings.length) return
  const unresolved = await deps.db
    .selectFrom('group_links')
    .selectAll()
    .where('space_id', '=', space)
    .where('target_id', 'is', null)
    .where('link', 'in', unique(spellings))
    .execute()
  for (const edge of unresolved) {
    const target = await resolve(deps, space, edge.link)
    if (!target) continue
    await deps.db
      .updateTable('group_links')
      .set({ target_id: target })
      .where('space_id', '=', space)
      .where('source_id', '=', edge.source_id)
      .where('link', '=', edge.link)
      .execute()
    for (const id of await ancestors(deps, space, [edge.source_id])) affected.add(id)
  }
}
function linkKeys(text: string, path: string) {
  return unique(
    parseGroupFrontmatter(text)
      .groups.map((link) => groupLinkKey(link, path))
      .filter((v): v is string => v !== null)
  ).sort()
}
/** Parse only a changed note. Bound IDs survive rename and deletion, so a replacement at
 * the old path never becomes the target of a formerly resolved link or token. */
export async function indexVersion(
  deps: AccessDeps & { store: BlobStore },
  version: Selectable<VersionsTable>,
  kind: string
) {
  const sources = [version.file_id]
  for (const asset of await deps.db
    .selectFrom('group_assets')
    .select('root_id')
    .where('space_id', '=', version.vault_id)
    .where('file_id', '=', version.file_id)
    .execute())
    sources.push(asset.root_id)
  for (const copy of await deps.db
    .selectFrom('group_copies')
    .select('original_id')
    .where('space_id', '=', version.vault_id)
    .where('file_id', '=', version.file_id)
    .execute())
    sources.push(copy.original_id)
  const old = await deps.db
    .selectFrom('group_notes')
    .selectAll()
    .where('space_id', '=', version.vault_id)
    .where('file_id', '=', version.file_id)
    .executeTakeFirst()
  if (version.op === 'delete' || kind !== 'note') {
    const affected = await ancestors(deps, version.vault_id, sources)
    await deps.db
      .deleteFrom('group_names')
      .where('space_id', '=', version.vault_id)
      .where('file_id', '=', version.file_id)
      .execute()
    await deps.db
      .deleteFrom('group_notes')
      .where('space_id', '=', version.vault_id)
      .where('file_id', '=', version.file_id)
      .execute()
    // Retyping is loss of live note identity just like deletion. Keep bound edges
    // as historical facts, never as live intermediates or name-resolution entries.
    await resolvePending(deps, version.vault_id, old ? spellingsOf(old.path) : [], affected)
    return affected
  }
  if (!version.blob_sha) return new Set<string>()
  const keys = linkKeys(await frontmatter(deps.store, version.blob_sha), version.path)
  const signature = JSON.stringify(keys)
  if (old?.signature === signature && old.path === version.path) return new Set<string>()
  const affected = await ancestors(deps, version.vault_id, sources)
  if (old?.signature !== signature) {
    const prior = await deps.db
      .selectFrom('group_links')
      .selectAll()
      .where('space_id', '=', version.vault_id)
      .where('source_id', '=', version.file_id)
      .execute()
    const kept = new Map(prior.map((e) => [e.link, e.target_id]))
    await deps.db
      .deleteFrom('group_links')
      .where('space_id', '=', version.vault_id)
      .where('source_id', '=', version.file_id)
      .execute()
    for (const key of keys)
      await deps.db
        .insertInto('group_links')
        .values({
          space_id: version.vault_id,
          source_id: version.file_id,
          link: key,
          target_id: kept.has(key) ? kept.get(key)! : await resolve(deps, version.vault_id, key),
        })
        .execute()
  }
  await deps.db
    .insertInto('group_notes')
    .values({ space_id: version.vault_id, file_id: version.file_id, path: version.path, signature })
    .onConflict((oc) =>
      oc.columns(['space_id', 'file_id']).doUpdateSet({ path: version.path, signature })
    )
    .execute()
  if (!old || old.path !== version.path) {
    const spellings = spellingsOf(version.path)
    await deps.db
      .deleteFrom('group_names')
      .where('space_id', '=', version.vault_id)
      .where('file_id', '=', version.file_id)
      .execute()
    for (const [i, name] of spellings.entries())
      await deps.db
        .insertInto('group_names')
        .values({
          space_id: version.vault_id,
          file_id: version.file_id,
          name,
          exact: i === 0 ? 1 : 0,
        })
        .execute()
    await resolvePending(
      deps,
      version.vault_id,
      [...spellings, ...(old ? spellingsOf(old.path) : [])],
      affected
    )
  }
  for (const id of await ancestors(deps, version.vault_id, [version.file_id])) affected.add(id)
  return affected
}
export async function qualifies(
  deps: AccessDeps & { store: BlobStore },
  scope: AccessScopesTable,
  path: string,
  sha: string
) {
  if (isConfigurationPath(path, deps.configurationDirectories)) return false
  if (!path.toLowerCase().endsWith('.md')) return false
  const keys = linkKeys(await frontmatter(deps.store, sha), path)
  for (const key of keys) {
    const target = await resolve(deps, scope.space_id, key)
    if (target && (await groupContains(deps, scope.space_id, scope.target_id, target))) return true
  }
  return false
}
async function currentItems(deps: AccessDeps, scope: AccessScopesTable): Promise<V2ManifestItem[]> {
  const ids = await closure(deps, scope.space_id, scope.target_id)
  // Publication follows the connection/group, never a body link or known hash.
  for (const id of [...ids]) {
    for (const asset of await deps.db
      .selectFrom('group_assets')
      .select('file_id')
      .where('space_id', '=', scope.space_id)
      .where('root_id', '=', id)
      .execute())
      ids.add(asset.file_id)
    for (const copy of await deps.db
      .selectFrom('group_copies')
      .select('file_id')
      .where('space_id', '=', scope.space_id)
      .where('original_id', '=', id)
      .execute())
      ids.add(copy.file_id)
  }
  const result: V2ManifestItem[] = []
  for (const id of ids) {
    const file = await deps.db
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
      .where('files.id', '=', id)
      .where('files.deleted_at', 'is', null)
      .executeTakeFirst()
    if (!file?.blob_sha || !(await groupPathAllowed(deps, scope, file.path))) continue
    result.push({
      file_id: file.id,
      version_id: file.version_id,
      path: file.path,
      kind: file.kind,
      sha: file.blob_sha,
      size: file.size,
      mtime: file.mtime,
    })
  }
  return result
}
export async function initializeGroup(deps: AccessDeps, scope: AccessScopesTable) {
  for (const item of await currentItems(deps, scope)) await remember(deps.db, scope.id, item)
}
async function eventCursor(deps: AccessDeps, space: string) {
  return (
    await deps.db
      .updateTable('vault_seq')
      .set({ head_seq: sql<number>`head_seq + 1` })
      .where('vault_id', '=', space)
      .returning('head_seq')
      .executeTakeFirstOrThrow()
  ).head_seq
}
/** Recompute only affected roots. Projection events have independent ordered cursors, so
 * one membership edit affecting thousands of notes remains correctly pageable. */
export async function refreshGroups(
  deps: AccessDeps,
  space: string,
  affected: Set<string>,
  at: string,
  versions: Selectable<VersionsTable>[] = [],
  all = false
) {
  // File projections inherit the graph too, including through intermediate groups.
  await refreshFileScopes(deps, space, at)
  const changedIds = unique(versions.map((v) => v.file_id))
  const changedScopes = changedIds.length
    ? (
        await deps.db
          .selectFrom('scope_members')
          .select('scope_id')
          .where('file_id', 'in', changedIds)
          .execute()
      ).map((row) => row.scope_id)
    : []
  let query = deps.db
    .selectFrom('access_scopes')
    .selectAll()
    .where('space_id', '=', space)
    .where('kind', '=', 'group')
  if (!all) {
    if (!affected.size && !changedScopes.length) return
    query = query.where((eb) =>
      eb.or([
        ...(affected.size ? [eb('target_id', 'in', [...affected])] : []),
        ...(changedScopes.length ? [eb('id', 'in', unique(changedScopes))] : []),
      ])
    )
  }
  const scopes = await query.execute()
  for (const scope of scopes) {
    const rebuild = all || affected.has(scope.target_id)
    if (!rebuild && !versions.length) continue
    if (!(await effectiveScope(deps, { scope, space: { id: space } })).active) continue // loss of authority never deletes local files
    const oldItems = rebuild
      ? await members(deps.db, scope.id)
      : (
          await deps.db
            .selectFrom('scope_members')
            .select('item')
            .where('scope_id', '=', scope.id)
            .where('file_id', 'in', changedIds)
            .execute()
        ).map((row) => JSON.parse(row.item) as V2ManifestItem)
    const before = new Map(oldItems.map((i) => [i.file_id, i]))
    const current = rebuild
      ? new Map((await currentItems(deps, scope)).map((i) => [i.file_id, i]))
      : new Map(before)
    if (!rebuild) {
      for (const v of versions)
        if (before.has(v.file_id)) {
          const file = await deps.db
            .selectFrom('files')
            .select(['kind', 'head_version_id'])
            .where('id', '=', v.file_id)
            .executeTakeFirstOrThrow()
          if (file.head_version_id === v.id && v.blob_sha)
            current.set(v.file_id, {
              file_id: v.file_id,
              version_id: v.id,
              path: v.path,
              sha: v.blob_sha,
              size: v.size,
              mtime: v.mtime,
              kind: file.kind,
            })
        }
    }
    for (const id of unique([...before.keys(), ...current.keys()])) {
      const old = before.get(id),
        item = current.get(id)
      const deleted = versions.find((v) => v.file_id === id && v.op === 'delete')
      if (item && old && item.version_id === old.version_id && item.path === old.path) continue
      const cursor = await eventCursor(deps, space)
      let event: V2Change
      if (item) {
        await remember(deps.db, scope.id, item)
        event = {
          type: 'content',
          cursor,
          at,
          file_id: id,
          path: item.path,
          item,
          prev_path: old && old.path !== item.path ? old.path : null,
        }
      } else {
        await deps.db
          .deleteFrom('scope_members')
          .where('scope_id', '=', scope.id)
          .where('file_id', '=', id)
          .execute()
        event = deleted
          ? { type: 'delete', cursor, at, file_id: id, path: old!.path, version_id: deleted.id }
          : { type: 'removal', cursor, at, file_id: id, path: old!.path }
        if (deleted)
          await deps.db
            .insertInto('scope_versions')
            .values({ scope_id: scope.id, file_id: id, version_id: deleted.id })
            .onConflict((oc) => oc.columns(['scope_id', 'version_id']).doNothing())
            .execute()
      }
      await deps.db
        .insertInto('scope_changes')
        .values({ scope_id: scope.id, cursor, type: event.type, event: JSON.stringify(event) })
        .execute()
    }
    // Retained losing/merge input versions from this authorized operation are history,
    // not independent membership facts. Never backfill private earlier versions at issue.
    for (const v of versions)
      if (current.has(v.file_id))
        await deps.db
          .insertInto('scope_versions')
          .values({ scope_id: scope.id, file_id: v.file_id, version_id: v.id })
          .onConflict((oc) => oc.columns(['scope_id', 'version_id']).doNothing())
          .execute()
  }
}
export async function publishExisting(
  deps: AccessDeps,
  scope: AccessScopesTable,
  fileId: string,
  tokenId: string,
  at: string
) {
  const file = await deps.db
    .selectFrom('scope_members')
    .select('file_id')
    .where('scope_id', '=', scope.id)
    .where('file_id', '=', fileId)
    .executeTakeFirst()
  if (!file) throw new AbeleError('not_found', 'no authorized file to publish')
  await deps.db
    .insertInto('group_assets')
    .values({
      space_id: scope.space_id,
      root_id: scope.target_id,
      file_id: fileId,
      published_by: tokenId,
      published_at: at,
    })
    .onConflict((oc) => oc.columns(['space_id', 'root_id', 'file_id']).doNothing())
    .execute()
}
