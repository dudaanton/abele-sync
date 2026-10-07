import {
  AbeleError,
  SCOPED_LIMITS,
  ScopedFeedPageSchema,
  ScopedManifestItemSchema,
  type ScopedFeedEvent,
  type ScopedFeedPage,
} from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { withScopedAuthority } from './authority.js'
import { folderVersionInTransaction } from './admissions.js'
import { decodeFeedProgress, encodeFeedProgress, restartFeed } from './feedCursor.js'
import type { SnapshotDeps } from './snapshots.js'

/** Grant-local ordered evidence only. Current authority filters every content item; old
 * interval content is omitted, while an evidenced departure/deletion remains a safe detach
 * signal without a path, blob hash, actor or vault-global activity counter.
 */
export async function pollFolderFeed(
  deps: SnapshotDeps,
  token: string,
  vaultId: string,
  grantId: string,
  checkpoint: unknown,
  limit = 1000
): Promise<ScopedFeedPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCOPED_LIMITS.max_page_items)
    throw new AbeleError('invalid_request', 'invalid feed page limit')
  return withScopedAuthority(deps, token, vaultId, grantId, 'read', async (tx, a) => {
    const progress = decodeFeedProgress(deps, a, checkpoint)
    const state = await tx
      .selectFrom('scope_feed_state')
      .selectAll()
      .where('grant_id', '=', grantId)
      .executeTakeFirst()
    if (
      !state ||
      progress.generation !== state.generation ||
      progress.position < state.minimum_position ||
      progress.position > state.position
    )
      throw restartFeed()
    const rows = await tx
      .selectFrom('scope_feed')
      .selectAll()
      .where('grant_id', '=', grantId)
      .where('generation', '=', state.generation)
      .where('position', '>', progress.position)
      .orderBy('position')
      .limit(limit)
      .execute()
    if (rows.length !== Math.min(limit, state.position - progress.position)) throw restartFeed()
    const events: ScopedFeedEvent[] = []
    let knownThrough = progress.known_through,
      representedPrefix = knownThrough === progress.position
    for (const [i, row] of rows.entries()) {
      if (row.position !== progress.position + i + 1 || !row.file_id || !row.interval_id)
        throw restartFeed()
      const interval = await tx
        .selectFrom('scope_admission_intervals')
        .select(['id', 'generation', 'ended_at', 'end_reason'])
        .where('id', '=', row.interval_id)
        .where('grant_id', '=', grantId)
        .where('vault_id', '=', vaultId)
        .where('file_id', '=', row.file_id)
        .executeTakeFirst()
      if (!interval) throw restartFeed()
      if (row.event_type === 'content') {
        if (!row.version_id) throw restartFeed()
        // Do not deliver content for a departed/private-gap interval, even if its bytes
        // are retained. A later safe detach event or fresh complete view reconciles it.
        if (interval.ended_at !== null) {
          representedPrefix = false
          continue
        }
        try {
          await folderVersionInTransaction(tx, a, row.file_id, row.version_id, authNow(deps), deps)
        } catch (error) {
          if (error instanceof AbeleError && error.code === 'not_found') {
            representedPrefix = false
            continue
          }
          throw error
        }
        let file
        try {
          if (row.safe_payload.length > 8192) throw restartFeed()
          file = ScopedManifestItemSchema.parse(JSON.parse(row.safe_payload))
          if (file.file_id !== row.file_id || file.version_id !== row.version_id)
            throw restartFeed()
        } catch {
          throw restartFeed()
        }
        events.push({ type: 'content', file })
        if (representedPrefix) knownThrough = row.position
      } else if (row.event_type === 'departed' || row.event_type === 'deleted') {
        // An older detach must not detach a newer re-entry already represented in this
        // page/checkpoint. A complete replay of this interval is not current authority.
        const current = await tx
          .selectFrom('scope_admission_intervals')
          .select('generation')
          .where('grant_id', '=', grantId)
          .where('file_id', '=', row.file_id)
          .orderBy('generation', 'desc')
          .executeTakeFirst()
        if (current && current.generation > interval.generation) {
          representedPrefix = false
          continue
        }
        // History may reopen an eligible deletion interval, but presentation
        // starts afresh after each deletion. An empty snapshot did not see trash.
        const previousDeletion = await tx
          .selectFrom('scope_feed')
          .select('position')
          .where('grant_id', '=', grantId)
          .where('generation', '=', state.generation)
          .where('interval_id', '=', interval.id)
          .where('event_type', '=', 'deleted')
          .where('position', '<', row.position)
          .orderBy('position', 'desc')
          .limit(1)
          .executeTakeFirst()
        const introduction = await tx
          .selectFrom('scope_feed')
          .select('position')
          .where('grant_id', '=', grantId)
          .where('generation', '=', state.generation)
          .where('interval_id', '=', interval.id)
          .where('event_type', '=', 'content')
          .where('position', '>', previousDeletion?.position ?? 0)
          .orderBy('position')
          .limit(1)
          .executeTakeFirst()
        if (!introduction) throw restartFeed()
        if (introduction.position > knownThrough) {
          // Introduced after this checkpoint and never represented: do not disclose
          // its identity. A prior suppressed-page prefix is uncertain, so restart.
          if (introduction.position <= progress.position) throw restartFeed()
          representedPrefix = false
          continue
        }
        if (row.event_type === 'departed') {
          if (interval.ended_at === null || interval.end_reason === 'deleted') throw restartFeed()
          events.push({ type: 'departed', file_id: row.file_id })
        } else {
          const trash = await tx
            .selectFrom('scope_trash')
            .select('interval_id')
            .where('grant_id', '=', grantId)
            .where('file_id', '=', row.file_id)
            .where('interval_id', '=', interval.id)
            .where('eligible', '=', 1)
            .where('expires_at', '>', authNow(deps).toISOString())
            .executeTakeFirst()
          if (!trash || interval.end_reason !== 'deleted') throw restartFeed()
          events.push({ type: 'deleted', file_id: row.file_id })
        }
        if (representedPrefix) knownThrough = row.position
      } else throw restartFeed()
    }
    const position = rows.at(-1)?.position ?? progress.position
    const next =
      position === progress.position
        ? checkpoint
        : encodeFeedProgress(deps, a, state.generation, position, knownThrough)
    return ScopedFeedPageSchema.parse({
      events,
      checkpoint: next,
      has_more: position < state.position,
    })
  })
}
