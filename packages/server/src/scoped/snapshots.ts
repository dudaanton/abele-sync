import {
  AbeleError,
  SCOPED_LIMITS,
  ScopedSnapshotPageSchema,
  type ScopedSnapshotPage,
} from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import { authNow } from '../auth/accounts.js'
import { newId } from '../ids.js'
import { SCOPED_RESOURCE_LIMITS } from './resourceLimits.js'
import type { Database } from '../db/schema.js'
import type { BlobStore } from '../blobs/store.js'
import { withScopedAuthority, type ScopedAuthority, type ScopedDeps } from './authority.js'
import { folderVersionInTransaction } from './admissions.js'
import type { AdmissionOptions } from './admissionPolicy.js'
import { encodeFeedProgress } from './feedCursor.js'
import {
  decodeSnapshotCursor,
  encodeSnapshotCursor,
  unavailable,
  type CursorStore,
  type SnapshotCursor,
} from './snapshotCursor.js'

export type SnapshotDeps = ScopedDeps & AdmissionOptions & CursorStore & { store: BlobStore }
const MAX_SNAPSHOT_ITEMS = 100000
function pageLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCOPED_LIMITS.max_page_items)
    throw new AbeleError('invalid_request', 'snapshot page limit must be between 1 and 1000')
}
function bound(cursor: SnapshotCursor, a: ScopedAuthority): void {
  if (
    cursor.vault_id !== a.principal.vault_id ||
    cursor.grant_id !== a.principal.grant_id ||
    cursor.principal_kind !== a.principal.kind ||
    cursor.principal_id !== a.principal.principal_id ||
    cursor.authority !== a.digest
  )
    throw unavailable()
}
async function page(
  tx: Transaction<Database>,
  deps: SnapshotDeps,
  a: ScopedAuthority,
  cursor: SnapshotCursor
): Promise<ScopedSnapshotPage> {
  bound(cursor, a)
  const at = authNow(deps)
  const header = await tx
    .selectFrom('scope_snapshots')
    .selectAll()
    .where('id', '=', cursor.snapshot_id)
    .where('grant_id', '=', a.principal.grant_id)
    .where('vault_id', '=', a.principal.vault_id)
    .where('principal_kind', '=', a.principal.kind)
    .where('principal_id', '=', a.principal.principal_id)
    .executeTakeFirst()
  if (
    !header ||
    header.state === 'invalidated' ||
    Date.parse(header.expires_at) <= at.getTime() ||
    header.scope_revision !== a.scopeRevision ||
    header.acl_revision !== a.aclRevision ||
    header.publication_revision !== a.publicationRevision
  )
    throw unavailable()
  if (cursor.offset > header.row_count) throw unavailable()
  const captured = await tx
    .selectFrom('scope_snapshot_items')
    .select([
      'file_id',
      'version_id',
      'path',
      'kind',
      'sha',
      'size',
      'mtime',
      'ordinal',
      'interval_id',
    ])
    .where('snapshot_id', '=', header.id)
    .where('ordinal', '>=', cursor.offset)
    .orderBy('ordinal')
    .limit(cursor.limit)
    .execute()
  const expected = Math.min(cursor.limit, header.row_count - cursor.offset)
  if (captured.length !== expected) throw unavailable()
  for (const [i, item] of captured.entries()) {
    if (item.ordinal !== cursor.offset + i) throw unavailable()
    try {
      const admission = await folderVersionInTransaction(
        tx,
        a,
        item.file_id,
        item.version_id,
        at,
        deps
      )
      if (admission.interval_id !== item.interval_id) throw unavailable()
    } catch {
      throw unavailable()
    }
    // Exact captured head rows are served. We never replace them with later live heads.
  }
  const offset = cursor.offset + captured.length
  const next = offset < header.row_count ? encodeSnapshotCursor(deps, { ...cursor, offset }) : null
  if (next === null && header.state !== 'complete')
    await tx
      .updateTable('scope_snapshots')
      .set({ state: 'complete' })
      .where('id', '=', header.id)
      .execute()
  const items = captured.map(({ ordinal: _, interval_id: __, ...item }) => item)
  if (Date.parse(header.expires_at) <= authNow(deps).getTime()) throw unavailable()
  return ScopedSnapshotPageSchema.parse({
    snapshot_id: header.id,
    items,
    cursor: encodeSnapshotCursor(deps, cursor),
    next_cursor: next,
    checkpoint: { kind: 'scoped', token: cursor.checkpoint },
    ...(next === null
      ? {
          feed_checkpoint: encodeFeedProgress(
            deps,
            a,
            header.feed_generation,
            header.feed_position,
            header.feed_position
          ),
        }
      : {}),
  })
}
/** Materialize exact authorized rows and pins in the admission decision transaction.
 * No HTTP transaction spans pages; later pages bind and recheck the live authority.
 */
export async function openFolderSnapshot(
  deps: SnapshotDeps,
  token: string,
  vaultId: string,
  grantId: string,
  limit = 1000
): Promise<ScopedSnapshotPage> {
  pageLimit(limit)
  return withScopedAuthority(deps, token, vaultId, grantId, 'read', async (tx, a) => {
    const at = authNow(deps)
    await tx
      .deleteFrom('scope_snapshots')
      .where('grant_id', '=', grantId)
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where((eb) =>
        eb.or([eb('expires_at', '<=', at.toISOString()), eb('state', '=', 'invalidated')])
      )
      .execute()
    const active = await tx
      .selectFrom('scope_snapshots')
      .select('id')
      .where('grant_id', '=', grantId)
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where('expires_at', '>', at.toISOString())
      .where('state', 'in', ['paging', 'complete'])
      .limit(2)
      .execute()
    if (active.length >= SCOPED_LIMITS.max_snapshots)
      throw new AbeleError('too_large', 'active snapshot limit reached')
    const heads = await tx
      .selectFrom('scope_current_members')
      .selectAll()
      .where('grant_id', '=', grantId)
      .where('vault_id', '=', vaultId)
      .orderBy('path')
      .orderBy('file_id')
      .limit(MAX_SNAPSHOT_ITEMS + 1)
      .execute()
    if (heads.length > MAX_SNAPSHOT_ITEMS)
      throw new AbeleError('too_large', 'snapshot inventory bound reached')
    const pinCount = await tx
      .selectFrom('scope_snapshot_pins as pin')
      .innerJoin('scope_snapshots as snapshot', 'snapshot.id', 'pin.snapshot_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('pin.vault_id', '=', vaultId)
      .where('snapshot.expires_at', '>', at.toISOString())
      .where('snapshot.state', 'in', ['paging', 'complete'])
      .executeTakeFirst()
    if (Number(pinCount?.count ?? 0) + heads.length > SCOPED_RESOURCE_LIMITS.snapshotPins)
      throw new AbeleError('too_large', 'snapshot pin bound reached')
    for (const item of heads) {
      if (item.sha === null) throw unavailable()
      try {
        await folderVersionInTransaction(tx, a, item.file_id, item.version_id, at, deps)
      } catch {
        throw unavailable()
      }
      if (!(await deps.store.has(item.sha))) throw unavailable()
    }
    const feed = await tx
      .selectFrom('scope_feed_state')
      .select(['generation', 'position'])
      .where('grant_id', '=', grantId)
      .executeTakeFirst()
    if (!feed) throw unavailable()
    const id = newId()
    const expires = new Date(
      at.getTime() + SCOPED_LIMITS.snapshot_lifetime_seconds * 1000
    ).toISOString()
    await tx
      .insertInto('scope_snapshots')
      .values({
        id,
        grant_id: grantId,
        vault_id: vaultId,
        principal_kind: a.principal.kind,
        principal_id: a.principal.principal_id,
        key_id: a.principal.kind === 'key' ? a.principal.principal_id : null,
        installation_id: a.principal.kind === 'installation' ? a.principal.principal_id : null,
        scope_revision: a.scopeRevision,
        acl_revision: a.aclRevision,
        publication_revision: a.publicationRevision,
        feed_generation: feed.generation,
        feed_position: feed.position,
        row_count: heads.length,
        state: 'paging',
        created_at: at.toISOString(),
        expires_at: expires,
      })
      .execute()
    for (let from = 0; from < heads.length; from += 50) {
      const batch = heads.slice(from, from + 50)
      await tx
        .insertInto('scope_snapshot_items')
        .values(
          batch.map((item, i) => ({
            snapshot_id: id,
            grant_id: grantId,
            vault_id: vaultId,
            ordinal: from + i,
            file_id: item.file_id,
            interval_id: item.interval_id,
            version_id: item.version_id,
            path: item.path,
            kind: item.kind,
            sha: item.sha!,
            size: item.size,
            mtime: item.mtime,
          }))
        )
        .execute()
      await tx
        .insertInto('scope_snapshot_pins')
        .values(
          batch.map((item) => ({
            snapshot_id: id,
            grant_id: grantId,
            vault_id: vaultId,
            file_id: item.file_id,
            version_id: item.version_id,
            sha: item.sha!,
          }))
        )
        .execute()
    }
    // Keep the captured checkpoint stable across pages, but do not permit it
    // to assert knowledge of an unread inventory. Terminal-page proof is separate.
    const checkpoint = encodeFeedProgress(
      deps,
      a,
      feed.generation,
      feed.position,
      feed.position,
      heads.length > limit
    )
    const cursor: SnapshotCursor = {
      kind: 'page',
      snapshot_id: id,
      vault_id: vaultId,
      grant_id: grantId,
      principal_kind: a.principal.kind,
      principal_id: a.principal.principal_id,
      authority: a.digest,
      offset: 0,
      limit,
      checkpoint: checkpoint.token,
    }
    return page(tx, deps, a, cursor)
  })
}
export async function readFolderSnapshotPage(
  deps: SnapshotDeps,
  token: string,
  vaultId: string,
  grantId: string,
  cursor: string
): Promise<ScopedSnapshotPage> {
  // Authenticate/fence before interpreting untrusted progress or consulting any snapshot rows.
  return withScopedAuthority(deps, token, vaultId, grantId, 'read', (tx, a) =>
    page(tx, deps, a, decodeSnapshotCursor(deps, cursor))
  )
}
