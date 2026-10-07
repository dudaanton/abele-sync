import { AbeleError } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import { authNow } from '../auth/accounts.js'
import {
  liveAt,
  ownerGrant,
  withOwnerManagement,
  type OwnerManagementDeps,
} from '../auth/freshOwner.js'
import type { Database } from '../db/schema.js'
import { getVaultSettings } from '../vault/vaults.js'
import { fileKind } from '../oplog/kinds.js'
import { applyFolderAdmission } from './admissionState.js'
import { versionFolderFile, type AdmissionOptions } from './admissionPolicy.js'

export const FOLDER_BOOTSTRAP_LIMIT = 1000
const LEASE_MS = 5 * 60 * 1000
export type PreparationDeps = OwnerManagementDeps &
  AdmissionOptions & { folderPreparationPageSize?: number }
const options = (deps: AdmissionOptions) => ({
  configurationDirectories: deps.configurationDirectories ?? deps.config?.configurationDirectories,
})

/** Prove the exact head at the starting watermark through immutable head lineage.
 * The newest surviving pre-watermark row is not necessarily that head after GC.
 */
export async function headAtStart(
  tx: Transaction<Database>,
  vaultId: string,
  file: { id: string; head_version_id: string | null },
  start: number
) {
  let id = file.head_version_id
  const seen = new Set<string>()
  for (let depth = 0; id !== null && depth < 128; depth++) {
    if (seen.has(id)) throw new AbeleError('scope_unavailable', 'cyclic starting-head evidence')
    seen.add(id)
    const row = await tx
      .selectFrom('versions')
      .select(['id', 'seq', 'prev_version_id', 'no', 'path', 'op', 'blob_sha', 'size', 'mtime'])
      .where('vault_id', '=', vaultId)
      .where('file_id', '=', file.id)
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new AbeleError('scope_unavailable', 'starting head evidence was pruned')
    if (row.seq <= start) return row
    // Personal conflict copies are also genuine identity births, not a missing
    // predecessor. Their source lineage is separate from this head-chain proof.
    if (
      row.prev_version_id === null &&
      (row.op === 'create' || row.op === 'conflict') &&
      row.no === 1
    )
      return null
    id = row.prev_version_id
  }
  throw new AbeleError('scope_unavailable', 'starting-head proof bound reached')
}

/** One bounded, journal-atomic inventory page. The starting seq is frozen; changes
 * after it are replayed in order, including intermediate private departures.
 */
async function capture(
  tx: Transaction<Database>,
  grant: { id: string; folder_prefix: string | null },
  vaultId: string,
  at: Date,
  cursor: string | null,
  limit: number,
  deps: PreparationDeps
) {
  let files = tx
    .selectFrom('files')
    .select(['id', 'head_version_id'])
    .where('vault_id', '=', vaultId)
    .orderBy('id')
    .limit(limit + 1)
  if (cursor !== null) files = files.where('id', '>', cursor)
  const page = await files.execute(),
    batch = page.slice(0, limit)
  const progress = await tx
    .selectFrom('scope_folder_preparations')
    .select('start_seq')
    .where('grant_id', '=', grant.id)
    .executeTakeFirstOrThrow()
  const settings = await getVaultSettings({ db: tx }, vaultId)
  for (const file of batch) {
    const baseline = await headAtStart(tx, vaultId, file, progress.start_seq)
    if (!baseline) continue // created after capture started: replay is responsible.
    const security = await tx
      .selectFrom('version_security_sources')
      .selectAll()
      .where('version_id', '=', baseline.id)
      .where('vault_id', '=', vaultId)
      .executeTakeFirst()
    await applyFolderAdmission(
      tx,
      grant,
      {
        id: file.id,
        vault_id: vaultId,
        versionId: baseline.id,
        path: baseline.path,
        kind: fileKind(baseline.path, settings),
        security: security ?? null,
        sha: baseline.blob_sha,
        size: baseline.size,
        mtime: baseline.mtime,
        deleted: baseline.op === 'delete',
      },
      at,
      options(deps)
    )
  }
  const next = batch.at(-1)?.id ?? cursor
  await tx
    .updateTable('scope_folder_preparations')
    .set({
      inventory_cursor: next,
      phase: page.length <= limit ? 'replay' : 'capture',
      updated_at: at.toISOString(),
    })
    .where('grant_id', '=', grant.id)
    .execute()
  return {
    processed: batch.length,
    phase: page.length <= limit ? ('replay' as const) : ('capture' as const),
  }
}
/** The ordered version journal, not a final-head scan: a leave and re-entry within
 * one commit must close the former interval. The owner commit itself only appends
 * ordinary immutable security/version facts while preparation is running.
 */
async function replay(
  tx: Transaction<Database>,
  grant: { id: string; folder_prefix: string | null },
  vaultId: string,
  at: Date,
  limit: number,
  deps: PreparationDeps
) {
  const progress = await tx
    .selectFrom('scope_folder_preparations')
    .select('replay_seq')
    .where('grant_id', '=', grant.id)
    .executeTakeFirstOrThrow()
  const events = await tx
    .selectFrom('versions')
    .select(['id', 'file_id', 'path', 'op', 'blob_sha', 'size', 'mtime', 'seq'])
    .where('vault_id', '=', vaultId)
    .where('seq', '>', progress.replay_seq)
    .orderBy('seq')
    .limit(limit + 1)
    .execute()
  const settings = await getVaultSettings({ db: tx }, vaultId),
    batch = events.slice(0, limit)
  for (const [index, event] of batch.entries()) {
    if (event.seq !== progress.replay_seq + index + 1)
      throw new AbeleError('scope_unavailable', 'folder replay evidence has a private gap')
    const security = await tx
      .selectFrom('version_security_sources')
      .selectAll()
      .where('version_id', '=', event.id)
      .where('vault_id', '=', vaultId)
      .executeTakeFirst()
    await applyFolderAdmission(
      tx,
      grant,
      {
        id: event.file_id,
        vault_id: vaultId,
        versionId: event.id,
        path: event.path,
        kind: fileKind(event.path, settings),
        security: security ?? null,
        sha: event.blob_sha,
        size: event.size,
        mtime: event.mtime,
        deleted: event.op === 'delete',
      },
      at,
      options(deps)
    )
  }
  const last = batch.at(-1)?.seq ?? progress.replay_seq
  // The vault lock makes this watermark final until the next normal commit.
  const complete = events.length <= limit
  if (complete) {
    const head = await tx
      .selectFrom('vault_seq')
      .select('head_seq')
      .where('vault_id', '=', vaultId)
      .executeTakeFirst()
    if (!head || head.head_seq !== last)
      throw new AbeleError('scope_unavailable', 'folder replay evidence was pruned')
  }
  await tx
    .updateTable('scope_folder_preparations')
    .set({
      replay_seq: last,
      phase: complete ? 'complete' : 'replay',
      updated_at: at.toISOString(),
    })
    .where('grant_id', '=', grant.id)
    .execute()
  if (complete)
    await tx
      .updateTable('scope_grants')
      .set({ state: 'active' })
      .where('id', '=', grant.id)
      .execute()
  return { processed: batch.length, state: complete ? ('active' as const) : ('preparing' as const) }
}
export async function prepareFolderAdmissions(
  deps: PreparationDeps,
  token: string,
  vaultId: string,
  grantId: string
) {
  const limit = deps.folderPreparationPageSize ?? FOLDER_BOOTSTRAP_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FOLDER_BOOTSTRAP_LIMIT)
    throw new AbeleError('invalid_request', 'invalid folder preparation page size')
  return withOwnerManagement(deps, token, vaultId, async (tx) => {
    const grant = await ownerGrant(tx, vaultId, grantId, deps.dialect),
      at = authNow(deps)
    if (grant.revoked_at !== null || !liveAt(grant.expires_at, at))
      throw new AbeleError('forbidden', 'grant is retired')
    let progress = await tx
      .selectFrom('scope_folder_preparations')
      .selectAll()
      .where('grant_id', '=', grantId)
      .executeTakeFirst()
    if (grant.state === 'active' && progress?.phase === 'complete') {
      // An explicit owner preparation call also rechecks current admissions after
      // file-local security facts are lost/repaired. It cannot silently leave a
      // stale open interval while reporting the grant ready.
      const current = await tx
        .selectFrom('scope_current_members')
        .select(['file_id', 'version_id'])
        .where('grant_id', '=', grantId)
        .orderBy('file_id')
        .limit(FOLDER_BOOTSTRAP_LIMIT + 1)
        .execute()
      if (current.length > FOLDER_BOOTSTRAP_LIMIT)
        throw new AbeleError('scope_unavailable', 'reviewed paged reconciliation required')
      for (const item of current) {
        const source = await versionFolderFile(tx, vaultId, item.file_id, item.version_id)
        if (!source) throw new AbeleError('scope_unavailable', 'missing current security evidence')
        await applyFolderAdmission(
          tx,
          grant,
          {
            ...source.file,
            versionId: source.version.id,
            sha: source.version.blob_sha,
            size: source.version.size,
            mtime: source.version.mtime,
            deleted: source.version.op === 'delete',
          },
          at,
          options(deps)
        )
      }
      return { processed: current.length, state: 'active' as const }
    }
    if (grant.state !== 'preparing')
      throw new AbeleError('scope_unavailable', 'grant needs reviewed preparation')
    if (!progress) {
      const head = await tx
        .selectFrom('vault_seq')
        .select('head_seq')
        .where('vault_id', '=', vaultId)
        .executeTakeFirst()
      if (!head) throw new AbeleError('scope_unavailable', 'missing commit watermark')
      await tx
        .insertInto('scope_folder_preparations')
        .values({
          grant_id: grantId,
          vault_id: vaultId,
          phase: 'capture',
          start_seq: head.head_seq,
          inventory_cursor: null,
          replay_seq: head.head_seq,
          created_at: at.toISOString(),
          updated_at: at.toISOString(),
          expires_at: new Date(at.getTime() + LEASE_MS).toISOString(),
        })
        .execute()
      progress = await tx
        .selectFrom('scope_folder_preparations')
        .selectAll()
        .where('grant_id', '=', grantId)
        .executeTakeFirstOrThrow()
    }
    if (
      progress.phase === 'unavailable' ||
      progress.phase === 'complete' ||
      Date.parse(progress.expires_at) <= at.getTime()
    )
      throw new AbeleError('scope_unavailable', 'folder preparation requires reviewed recovery')
    if (progress.phase === 'capture') {
      const capturePage = await capture(
        tx,
        grant,
        vaultId,
        at,
        progress.inventory_cursor,
        limit,
        deps
      )
      if (capturePage.phase === 'capture')
        return { processed: capturePage.processed, state: 'preparing' as const }
      const replayPage = await replay(tx, grant, vaultId, at, limit, deps)
      return { processed: capturePage.processed + replayPage.processed, state: replayPage.state }
    }
    return replay(tx, grant, vaultId, at, limit, deps)
  })
}
