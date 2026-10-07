import { sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { SCOPED_RESOURCE_LIMITS } from './resourceLimits.js'
import { newId } from '../ids.js'
import { getVaultSettings } from '../vault/vaults.js'
import { folderReasons } from './admissionPolicy.js'
import type { FolderFile, SecurityOptions } from './folderSecurity.js'

export interface AdmittedInput extends FolderFile {
  id: string
  vault_id: string
  versionId: string
  sha: string | null
  size: number
  mtime: number
  deleted: boolean
}
export async function invalidateFolderViews(
  tx: Transaction<Database>,
  grantId: string
): Promise<void> {
  await tx
    .updateTable('scope_grants')
    .set({ scope_revision: sql<number>`scope_revision + 1` })
    .where('id', '=', grantId)
    .execute()
  await tx
    .updateTable('scope_snapshots')
    .set({ state: 'invalidated' })
    .where('grant_id', '=', grantId)
    .execute()
}
async function feed(
  tx: Transaction<Database>,
  grantId: string,
  type: 'content' | 'deleted' | 'departed',
  file: AdmittedInput,
  intervalId: string,
  at: Date
) {
  const state = await tx
    .updateTable('scope_feed_state')
    .set({ position: sql<number>`position + 1`, updated_at: at.toISOString() })
    .where('grant_id', '=', grantId)
    .returning(['position', 'generation'])
    .executeTakeFirst()
  if (!state) throw new Error('folder grant has no feed state')
  const payload =
    type === 'content'
      ? {
          file_id: file.id,
          version_id: file.versionId,
          path: file.path,
          sha: file.sha,
          size: file.size,
          mtime: file.mtime,
          kind: file.kind,
        }
      : { file_id: file.id, type }
  await tx
    .insertInto('scope_feed')
    .values({
      grant_id: grantId,
      generation: state.generation,
      position: state.position,
      event_type: type,
      file_id: file.id,
      interval_id: intervalId,
      version_id: type === 'content' ? file.versionId : null,
      safe_payload: JSON.stringify(payload),
      at: at.toISOString(),
    })
    .execute()
  const cutoff = state.position - SCOPED_RESOURCE_LIMITS.feedEvents
  if (cutoff > 0) {
    await tx
      .deleteFrom('scope_feed')
      .where('grant_id', '=', grantId)
      .where('generation', '=', state.generation)
      .where('position', '<=', cutoff)
      .execute()
    await tx
      .updateTable('scope_feed_state')
      .set({ minimum_position: cutoff })
      .where('grant_id', '=', grantId)
      .execute()
  }
}
/** Removing intrinsic sponsor authority must cascade before the next payload. Last-sponsor
 * loss retires the entry/generation, never leaving dormant permission that re-entry revives.
 */
async function removeSponsorships(
  tx: Transaction<Database>,
  grantId: string,
  noteId: string,
  at: Date
): Promise<void> {
  const rows = await tx
    .selectFrom('scope_extra_sponsors')
    .select('entry_id')
    .where('grant_id', '=', grantId)
    .where('note_id', '=', noteId)
    .execute()
  await tx
    .deleteFrom('scope_extra_sponsors')
    .where('grant_id', '=', grantId)
    .where('note_id', '=', noteId)
    .execute()
  for (const { entry_id } of rows) {
    const remaining = await tx
      .selectFrom('scope_extra_sponsors')
      .select('note_id')
      .where('entry_id', '=', entry_id)
      .limit(1)
      .executeTakeFirst()
    if (remaining) continue
    const entry = await tx
      .updateTable('scope_extra_entries')
      .set({
        withdrawn_at: at.toISOString(),
        withdrawal_generation: sql<number>`withdrawal_generation + 1`,
      })
      .where('id', '=', entry_id)
      .returning(['file_id', 'vault_id'])
      .executeTakeFirstOrThrow()
    // Deleted targets have no current-member row. Retire their extra-only trash
    // too; cached deletion evidence is not an independent authority ground.
    const deleted = await tx
      .selectFrom('scope_trash as trash')
      .innerJoin('scope_admission_intervals as interval', 'interval.id', 'trash.interval_id')
      .select('trash.interval_id')
      .where('trash.grant_id', '=', grantId)
      .where('trash.file_id', '=', entry.file_id)
      .where('interval.intrinsic', '=', 0)
      .execute()
    if (deleted.length)
      await tx
        .updateTable('scope_trash')
        .set({ eligible: 0 })
        .where('grant_id', '=', grantId)
        .where('file_id', '=', entry.file_id)
        .where(
          'interval_id',
          'in',
          deleted.map((row) => row.interval_id)
        )
        .execute()
    // Independent intrinsic scope is still authority; an extra withdrawal cannot defeat it.
    const current = await tx
      .selectFrom('scope_current_members as member')
      .innerJoin('scope_admission_intervals as interval', 'interval.id', 'member.interval_id')
      .select([
        'member.interval_id',
        'interval.intrinsic',
        'member.file_id',
        'member.path',
        'member.kind',
        'member.version_id',
        'member.sha',
        'member.size',
        'member.mtime',
      ])
      .where('member.grant_id', '=', grantId)
      .where('member.file_id', '=', entry.file_id)
      .executeTakeFirst()
    if (current && current.intrinsic === 0) {
      await tx
        .updateTable('scope_admission_intervals')
        .set({ ended_at: at.toISOString(), end_reason: 'departed' })
        .where('id', '=', current.interval_id)
        .execute()
      await tx
        .deleteFrom('scope_current_members')
        .where('grant_id', '=', grantId)
        .where('file_id', '=', entry.file_id)
        .execute()
      await tx
        .updateTable('scope_trash')
        .set({ eligible: 0 })
        .where('grant_id', '=', grantId)
        .where('file_id', '=', entry.file_id)
        .execute()
      await invalidateFolderViews(tx, grantId)
      await feed(
        tx,
        grantId,
        'departed',
        {
          id: current.file_id,
          vault_id: entry.vault_id,
          path: current.path,
          kind: current.kind,
          versionId: current.version_id,
          sha: current.sha,
          size: current.size,
          mtime: current.mtime,
          deleted: false,
        },
        current.interval_id,
        at
      )
    }
    await tx
      .updateTable('scope_grants')
      .set({ publication_revision: sql<number>`publication_revision + 1` })
      .where('id', '=', grantId)
      .execute()
  }
}
/** A grant's expired authority is a real interval break, even if its skipped writes
 * returned to the same path before renewal. Never infer the missed private gap.
 */
export async function closeExpiredGrantIntervals(
  tx: Transaction<Database>,
  grantId: string,
  at: Date
): Promise<void> {
  await tx.updateTable('scope_trash').set({ eligible: 0 }).where('grant_id', '=', grantId).execute()
  // Whole-grant retirement is set-based under the owner/vault/grant fences: no
  // inventory in process memory, per-file SQL fanout, or 1,000-member ceiling.
  await tx
    .updateTable('scope_admission_intervals')
    .set({ ended_at: at.toISOString(), end_reason: 'departed' })
    .where('grant_id', '=', grantId)
    .where('ended_at', 'is', null)
    .execute()
  await tx.deleteFrom('scope_current_members').where('grant_id', '=', grantId).execute()
  await tx.deleteFrom('scope_extra_sponsors').where('grant_id', '=', grantId).execute()
  await tx
    .updateTable('scope_extra_entries')
    .set({ withdrawn_at: at.toISOString() })
    .where('grant_id', '=', grantId)
    .where('withdrawn_at', 'is', null)
    .execute()
  // A reset requires a new complete view, not thousands of individual departures
  // from a revoked/expired baseline. Retire its feed generation atomically too.
  await tx.deleteFrom('scope_feed').where('grant_id', '=', grantId).execute()
  await tx
    .updateTable('scope_feed_state')
    .set({
      generation: sql<number>`generation + 1`,
      position: 0,
      minimum_position: 0,
      updated_at: at.toISOString(),
    })
    .where('grant_id', '=', grantId)
    .execute()
  // The owner mutation advances ACL/scope revisions exactly once; invalidate
  // leases here without a second publication-revision increment.
  await tx
    .updateTable('scope_snapshots')
    .set({ state: 'invalidated' })
    .where('grant_id', '=', grantId)
    .execute()
}

/** One ordered version transition, not a final-head inventory reparse. */
export async function applyFolderAdmission(
  tx: Transaction<Database>,
  grant: { id: string; folder_prefix: string | null },
  file: AdmittedInput,
  at: Date,
  options: SecurityOptions,
  certifiedReasons?: { eligible: boolean; intrinsic: boolean }
): Promise<void> {
  let interval = await tx
    .selectFrom('scope_admission_intervals')
    .selectAll()
    .where('grant_id', '=', grant.id)
    .where('file_id', '=', file.id)
    .where('ended_at', 'is', null)
    .executeTakeFirst()
  const current = await tx
    .selectFrom('scope_current_members')
    .selectAll()
    .where('grant_id', '=', grant.id)
    .where('file_id', '=', file.id)
    .executeTakeFirst()
  const reasons = certifiedReasons ?? (await folderReasons(tx, grant, file, at, options))
  if (file.deleted || !reasons.eligible) {
    if (!interval) return
    await removeSponsorships(tx, grant.id, file.id, at)
    const deleted = file.deleted && reasons.eligible && current !== undefined
    if (deleted) {
      const settings = await getVaultSettings({ db: tx }, file.vault_id)
      const retentionDays =
        file.kind === 'note' || file.kind === 'canvas'
          ? settings.retention.notes_days
          : settings.retention.attachments_days
      const trashMs = Math.max(
        1,
        Math.min(24 * 60 * 60 * 1000, retentionDays * 24 * 60 * 60 * 1000)
      )
      await tx
        .insertInto('scope_version_admissions')
        .values({
          grant_id: grant.id,
          vault_id: file.vault_id,
          file_id: file.id,
          interval_id: interval.id,
          generation: interval.generation,
          version_id: file.versionId,
          admitted_at: at.toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['grant_id', 'file_id', 'interval_id', 'version_id']).doNothing()
        )
        .execute()
      await tx
        .insertInto('scope_trash')
        .values({
          grant_id: grant.id,
          vault_id: file.vault_id,
          file_id: file.id,
          interval_id: interval.id,
          last_version_id: current.version_id,
          deleted_version_id: file.versionId,
          deleted_at: at.toISOString(),
          expires_at: new Date(at.getTime() + trashMs).toISOString(),
          eligible: retentionDays === 0 ? 0 : 1,
        })
        .onConflict((oc) =>
          oc.columns(['grant_id', 'file_id', 'interval_id']).doUpdateSet({
            last_version_id: current.version_id,
            deleted_version_id: file.versionId,
            deleted_at: at.toISOString(),
            expires_at: new Date(at.getTime() + trashMs).toISOString(),
            eligible: retentionDays === 0 ? 0 : 1,
          })
        )
        .execute()
    } else
      await tx
        .updateTable('scope_trash')
        .set({ eligible: 0 })
        .where('grant_id', '=', grant.id)
        .where('file_id', '=', file.id)
        .execute()
    await tx
      .updateTable('scope_admission_intervals')
      .set({ ended_at: at.toISOString(), end_reason: deleted ? 'deleted' : 'departed' })
      .where('id', '=', interval.id)
      .execute()
    await tx
      .deleteFrom('scope_current_members')
      .where('grant_id', '=', grant.id)
      .where('file_id', '=', file.id)
      .execute()
    await invalidateFolderViews(tx, grant.id)
    await feed(tx, grant.id, deleted ? 'deleted' : 'departed', file, interval.id, at)
    return
  }
  if (!interval) {
    // A genuine still-authorized deletion is not a private departure. Restore
    // through its exact deleted head retains this interval's admitted history.
    const written = await tx
      .selectFrom('versions')
      .select('prev_version_id')
      .where('id', '=', file.versionId)
      .where('vault_id', '=', file.vault_id)
      .executeTakeFirst()
    const previous = written?.prev_version_id
      ? await tx
          .selectFrom('scope_trash as trash')
          .innerJoin('files as file', 'file.id', 'trash.file_id')
          .select('trash.interval_id')
          .where('trash.grant_id', '=', grant.id)
          .where('trash.file_id', '=', file.id)
          .where('trash.vault_id', '=', file.vault_id)
          .where('trash.eligible', '=', 1)
          .where('trash.expires_at', '>', at.toISOString())
          .where('trash.deleted_version_id', '=', written.prev_version_id)
          .where('file.deleted_at', 'is not', null)
          .where((eb) => eb('trash.deleted_version_id', '=', eb.ref('file.head_version_id')))
          .executeTakeFirst()
      : undefined
    if (previous) {
      const closed = await tx
        .selectFrom('scope_admission_intervals')
        .selectAll()
        .where('id', '=', previous.interval_id)
        .where('grant_id', '=', grant.id)
        .where('end_reason', '=', 'deleted')
        .executeTakeFirst()
      if (closed) {
        await tx
          .updateTable('scope_admission_intervals')
          .set({ ended_at: null, end_reason: null })
          .where('id', '=', closed.id)
          .execute()
        interval = { ...closed, ended_at: null, end_reason: null }
        await tx
          .updateTable('scope_trash')
          .set({ eligible: 0 })
          .where('grant_id', '=', grant.id)
          .where('file_id', '=', file.id)
          .execute()
        await invalidateFolderViews(tx, grant.id)
      }
    }
  }
  let id = interval?.id,
    generation = interval?.generation
  if (!interval) {
    const previous = await tx
      .selectFrom('scope_admission_intervals')
      .select((eb) => eb.fn.max<number>('generation').as('generation'))
      .where('grant_id', '=', grant.id)
      .where('file_id', '=', file.id)
      .executeTakeFirst()
    id = newId()
    generation = Number(previous?.generation ?? 0) + 1
    await tx
      .insertInto('scope_admission_intervals')
      .values({
        id,
        grant_id: grant.id,
        vault_id: file.vault_id,
        file_id: file.id,
        generation,
        intrinsic: reasons.intrinsic ? 1 : 0,
        baseline_version_id: file.versionId,
        admitted_at: at.toISOString(),
        ended_at: null,
        end_reason: null,
      })
      .execute()
    await tx
      .updateTable('scope_trash')
      .set({ eligible: 0 })
      .where('grant_id', '=', grant.id)
      .where('file_id', '=', file.id)
      .execute()
    await invalidateFolderViews(tx, grant.id)
  } else if (interval.intrinsic !== Number(reasons.intrinsic)) {
    if (!reasons.intrinsic) await removeSponsorships(tx, grant.id, file.id, at)
    await tx
      .updateTable('scope_admission_intervals')
      .set({ intrinsic: reasons.intrinsic ? 1 : 0 })
      .where('id', '=', interval.id)
      .execute()
  }
  // A folder member may remain intrinsic while it stops being a note. It can no
  // longer sponsor any extra; retire the sponsorship before publishing this head.
  if (reasons.intrinsic && current?.kind === 'note' && file.kind !== 'note')
    await removeSponsorships(tx, grant.id, file.id, at)
  if (!id || generation === undefined) throw new Error('missing admission interval')
  await tx
    .insertInto('scope_version_admissions')
    .values({
      grant_id: grant.id,
      vault_id: file.vault_id,
      file_id: file.id,
      interval_id: id,
      generation,
      version_id: file.versionId,
      admitted_at: at.toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(['grant_id', 'file_id', 'interval_id', 'version_id']).doNothing()
    )
    .execute()
  if (file.kind === 'script' || file.kind === 'settings') throw new Error('restricted scope head')
  const kind = file.kind
  await tx
    .insertInto('scope_current_members')
    .values({
      grant_id: grant.id,
      vault_id: file.vault_id,
      file_id: file.id,
      interval_id: id,
      version_id: file.versionId,
      path: file.path,
      kind,
      sha: file.sha,
      size: file.size,
      mtime: file.mtime,
    })
    .onConflict((oc) =>
      oc.columns(['grant_id', 'file_id']).doUpdateSet({
        interval_id: id,
        version_id: file.versionId,
        path: file.path,
        kind,
        sha: file.sha,
        size: file.size,
        mtime: file.mtime,
      })
    )
    .execute()
  if (current?.version_id !== file.versionId) await feed(tx, grant.id, 'content', file, id, at)
}
