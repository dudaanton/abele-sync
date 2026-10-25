import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import {
  AbeleError,
  V2ChangeSchema,
  V2ManifestItemSchema,
  type V2Manifest,
  type V2Changes,
} from '@abele/sync-protocol'
import { withVaultLock } from '../oplog/lock.js'
import { headSeqOf } from '../oplog/changes.js'
import {
  authenticateToken,
  effectiveScope,
  type AccessDeps,
  type TokenPrincipal,
} from './tokens.js'
import {
  activeScope,
  member,
  versionVisible,
  covers,
  selectorWasDeleted,
  historyAuthority,
} from './visibility.js'

export async function withToken<T>(
  deps: AccessDeps,
  key: string,
  run: (deps: AccessDeps, principal: TokenPrincipal) => Promise<T>,
  allowFinalSelectorDeletes = false
): Promise<T> {
  const initial = await authenticateToken(deps, key)
  return withVaultLock(deps.db, deps.dialect ?? 'sqlite', initial.space.id, async (db) => {
    const tx = { ...deps, db }
    const principal = await authenticateToken(tx, key)
    if (!(allowFinalSelectorDeletes && (await selectorWasDeleted(tx, principal.scope))))
      await activeScope(tx, principal)
    return run(tx, principal)
  })
}
const invalidPage = () => new AbeleError('invalid_request', 'invalid or expired page cursor')
const SNAPSHOT_IDLE_MS = 60 * 60 * 1000
const SNAPSHOT_MAX_MS = 7 * 24 * SNAPSHOT_IDLE_MS
export async function manifestWithToken(
  deps: AccessDeps,
  key: string,
  limit: number,
  next?: string
): Promise<V2Manifest> {
  return withToken(deps, key, async (deps, p) => {
    const now = (deps.now?.() ?? new Date()).toISOString()
    let snapshotId: string,
      after = '',
      pageLimit = limit
    if (next) {
      try {
        const page = JSON.parse(Buffer.from(next, 'base64url').toString('utf8'))
        if (
          typeof page.id !== 'string' ||
          typeof page.after !== 'string' ||
          !Number.isInteger(page.limit) ||
          page.limit < 1 ||
          page.limit > 5000
        )
          throw invalidPage()
        snapshotId = page.id
        after = page.after
        pageLimit = page.limit
      } catch {
        throw invalidPage()
      }
    } else {
      const cursor = await headSeqOf(deps.db, p.space.id)
      const existing = await deps.db
        .selectFrom('scope_snapshots')
        .select('id')
        .where('scope_id', '=', p.scope.id)
        .where('cursor', '=', cursor)
        .where('expires_at', '>', now)
        .orderBy('expires_at', 'desc')
        .executeTakeFirst()
      snapshotId = existing?.id ?? randomUUID()
      if (!existing) {
        await deps.db.deleteFrom('scope_snapshots').where('expires_at', '<=', now).execute()
        await deps.db
          .insertInto('scope_snapshots')
          .values({
            id: snapshotId,
            scope_id: p.scope.id,
            cursor,
            created_at: now,
            expires_at: new Date(Date.parse(now) + SNAPSHOT_IDLE_MS).toISOString(),
          })
          .execute()
        await deps.db
          .insertInto('scope_snapshot_items')
          .columns(['snapshot_id', 'file_id', 'item'])
          .expression((eb) =>
            eb
              .selectFrom('scope_members')
              .select([sql<string>`${snapshotId}`.as('snapshot_id'), 'file_id', 'item'])
              .where('scope_id', '=', p.scope.id)
          )
          .execute()
      }
    }
    const snapshot = await deps.db
      .selectFrom('scope_snapshots')
      .selectAll()
      .where('id', '=', snapshotId)
      .where('scope_id', '=', p.scope.id)
      .where('expires_at', '>', now)
      .executeTakeFirst()
    if (!snapshot) throw invalidPage()
    const created =
      snapshot.created_at ??
      new Date(Date.parse(snapshot.expires_at) - SNAPSHOT_IDLE_MS).toISOString()
    const expires = Math.min(
      Date.parse(now) + SNAPSHOT_IDLE_MS,
      Date.parse(created) + SNAPSHOT_MAX_MS
    )
    if (expires <= Date.parse(now)) throw invalidPage()
    if (
      Date.parse(snapshot.expires_at) - Date.parse(now) <= SNAPSHOT_IDLE_MS / 2 &&
      expires > Date.parse(snapshot.expires_at)
    )
      await deps.db
        .updateTable('scope_snapshots')
        .set({ created_at: created, expires_at: new Date(expires).toISOString() })
        .where('id', '=', snapshotId)
        .execute()
    const rows = await deps.db
      .selectFrom('scope_snapshot_items')
      .select(['file_id', 'item'])
      .where('snapshot_id', '=', snapshotId)
      .where('file_id', '>', after)
      .orderBy('file_id')
      .limit(pageLimit + 1)
      .execute()
    const items = rows
      .slice(0, pageLimit)
      .map((r) => V2ManifestItemSchema.parse(JSON.parse(r.item)))
    return {
      cursor: snapshot.cursor,
      items,
      next:
        rows.length > pageLimit
          ? Buffer.from(
              JSON.stringify({ id: snapshotId, after: items.at(-1)!.file_id, limit: pageLimit })
            ).toString('base64url')
          : null,
    }
  })
}
export async function changesWithToken(
  deps: AccessDeps,
  key: string,
  since: number,
  limit: number
): Promise<V2Changes> {
  return withToken(
    deps,
    key,
    async (deps, p) => {
      const active = (await effectiveScope(deps, p)).active
      let query = deps.db
        .selectFrom('scope_changes')
        .selectAll()
        .where('scope_id', '=', p.scope.id)
        .where('cursor', '>', since)
      // A deleted selector's credential can drain genuine final deletes, not read
      // content, old content events, private destinations or new replacement folders.
      if (!active) query = query.where('type', '=', 'delete')
      const rows = await query
        .orderBy('cursor')
        .limit(limit + 1)
        .execute()
      const items = rows.slice(0, limit).map((row) => V2ChangeSchema.parse(JSON.parse(row.event)))
      const more = rows.length > limit
      const end = active
        ? await headSeqOf(deps.db, p.space.id)
        : ((
            await deps.db
              .selectFrom('scope_changes')
              .select('cursor')
              .where('scope_id', '=', p.scope.id)
              .orderBy('cursor', 'desc')
              .executeTakeFirst()
          )?.cursor ?? 0)
      const cursor = more ? items.at(-1)!.cursor : end
      return { items, cursor, next: more ? String(cursor) : null }
    },
    true
  )
}
/** Both current membership and version-time visibility are required; a guessed digest is never read. */
export async function contentWithToken(
  deps: AccessDeps,
  key: string,
  fileId: string,
  versionId?: string
) {
  return withToken(deps, key, async (deps, p) => {
    const current = await member(deps.db, p.scope.id, fileId)
    if (versionId) await historyAuthority(deps, p, fileId)
    else if (
      !current ||
      current.kind === 'directory' ||
      !(await covers(deps, p.scope, current.path, fileId))
    )
      throw new AbeleError('not_found', 'no file in this scope')
    const wanted = versionId ?? current!.version_id
    if (!(await versionVisible(deps.db, p.scope.id, fileId, wanted)))
      throw new AbeleError('not_found', 'no version in this scope')
    const version = await deps.db
      .selectFrom('versions')
      .select(['blob_sha', 'size'])
      .where('id', '=', wanted)
      .where('file_id', '=', fileId)
      .where('vault_id', '=', p.space.id)
      .executeTakeFirst()
    if (!version?.blob_sha) throw new AbeleError('not_found', 'no content for this version')
    return version
  })
}
