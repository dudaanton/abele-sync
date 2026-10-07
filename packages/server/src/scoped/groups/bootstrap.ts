import { AbeleError } from '@abele/sync-protocol'
import { z } from 'zod'
import { withOwnerManagement, type OwnerManagementDeps } from '../../auth/freshOwner.js'
import { authNow } from '../../auth/accounts.js'
import { newId } from '../../ids.js'
import { sql } from 'kysely'
import { closeExpiredGrantIntervals } from '../admissionState.js'
import { headAtStart } from '../folderPreparation.js'
import {
  processGroupVersion,
  groupUnavailable,
  parseGroupEvidenceJson,
  type GroupFactDeps,
} from './versionFacts.js'
import { setGroupAdmissionStart } from './grantBaseline.js'
import { retireGroupApprovals } from './audienceApproval.js'
import { SCOPED_RESOURCE_LIMITS } from '../resourceLimits.js'
import { withGroupBootstrapPage } from './bootstrapPage.js'
export type GroupBootstrapDeps = GroupFactDeps & OwnerManagementDeps
const BootstrapCursor = z
  .object({
    after: z.string().min(1).max(200).nullable(),
    lease: z.string().min(1).max(200),
  })
  .strict()
/** Explicit reviewed owner recovery, never an automatic lease renewal. */
export function rebuildGroupBootstrap(
  deps: GroupBootstrapDeps,
  token: string,
  vaultId: string,
  expectedGeneration: number
) {
  return withOwnerManagement(deps, token, vaultId, async (tx) => {
    const progress = await tx
      .selectFrom('scope_group_progress')
      .selectAll()
      .where('vault_id', '=', vaultId)
      .executeTakeFirst()
    if (!progress || progress.generation !== expectedGeneration)
      throw new AbeleError('conflict', 'group recovery preview changed')
    const at = authNow(deps),
      head = await tx
        .selectFrom('vault_seq')
        .select('head_seq')
        .where('vault_id', '=', vaultId)
        .executeTakeFirstOrThrow()
    const grants = await tx
      .selectFrom('scope_grants')
      .select('id')
      .where('vault_id', '=', vaultId)
      .where('selector_kind', '=', 'group')
      .where('revoked_at', 'is', null)
      .limit(65)
      .execute()
    if (grants.length > 64) throw groupUnavailable()
    await retireGroupApprovals(tx, vaultId)
    for (const grant of grants) {
      await closeExpiredGrantIntervals(tx, grant.id, at)
      await setGroupAdmissionStart(tx, vaultId, grant.id, head.head_seq, at, true)
      await tx
        .updateTable('scope_grants')
        .set({ state: 'preparing', scope_revision: sql<number>`scope_revision + 1` })
        .where('id', '=', grant.id)
        .execute()
    }
    await tx
      .updateTable('scope_group_progress')
      .set({
        generation: sql<number>`generation + 1`,
        processed_seq: head.head_seq,
        bootstrap_start_seq: head.head_seq,
        bootstrap_cursor: null,
        status: 'preparing',
        updated_at: at.toISOString(),
      })
      .where('vault_id', '=', vaultId)
      .execute()
    return { generation: progress.generation + 1 }
  })
}
/** Frozen paged capture. Missing actual watermark-head proof and expired leases
 * hold reviewed recovery; neither restarts nor chooses an older surviving head.
 */
export async function prepareGroupBootstrap(
  deps: GroupBootstrapDeps,
  token: string,
  vaultId: string,
  limit = 1000
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new AbeleError('invalid_request', 'invalid group bootstrap page size')
  const outcome = await withOwnerManagement(deps, token, vaultId, async (tx) => {
    const at = authNow(deps),
      live = await tx
        .selectFrom('scope_grants')
        .select('id')
        .where('vault_id', '=', vaultId)
        .where('selector_kind', '=', 'group')
        .where('revoked_at', 'is', null)
        .where('state', 'in', ['active', 'preparing'])
        .where((eb) =>
          eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())])
        )
        .limit(1)
        .executeTakeFirst()
    if (!live) throw new AbeleError('not_found', 'no preparing group authority')
    return withGroupBootstrapPage(tx, vaultId, at, async () => {
      const missing = await tx
        .selectFrom('scope_grants as grant')
        .leftJoin('scope_folder_preparations as baseline', 'baseline.grant_id', 'grant.id')
        .select('grant.id')
        .where('grant.vault_id', '=', vaultId)
        .where('grant.selector_kind', '=', 'group')
        .where('grant.revoked_at', 'is', null)
        .where('baseline.grant_id', 'is', null)
        .limit(65)
        .execute()
      if (missing.length > 64) throw groupUnavailable()
      if (missing.length) {
        const head = await tx
          .selectFrom('vault_seq')
          .select('head_seq')
          .where('vault_id', '=', vaultId)
          .executeTakeFirstOrThrow()
        for (const grant of missing) {
          await closeExpiredGrantIntervals(tx, grant.id, at)
          await setGroupAdmissionStart(tx, vaultId, grant.id, head.head_seq, at)
        }
      }
      let progress = await tx
        .selectFrom('scope_group_progress')
        .selectAll()
        .where('vault_id', '=', vaultId)
        .executeTakeFirst()
      if (progress?.status === 'unavailable') throw groupUnavailable()
      if (progress?.bootstrap_cursor === 'complete')
        return {
          processed: 0,
          phase: progress.status === 'ready' ? ('ready' as const) : ('replay' as const),
        }
      if (!progress || progress.bootstrap_cursor === null) {
        const head = await tx
          .selectFrom('vault_seq')
          .select('head_seq')
          .where('vault_id', '=', vaultId)
          .executeTakeFirstOrThrow()
        const start = progress?.bootstrap_start_seq ?? head.head_seq,
          lease = newId()
        await tx
          .insertInto('scope_group_leases')
          .values({
            id: lease,
            vault_id: vaultId,
            start_seq: start,
            created_at: at.toISOString(),
            expires_at: new Date(at.getTime() + 300000).toISOString(),
          })
          .execute()
        const values = {
          processed_seq: start,
          bootstrap_start_seq: start,
          bootstrap_cursor: JSON.stringify({ after: null, lease }),
          status: 'preparing' as const,
          updated_at: at.toISOString(),
        }
        await tx
          .insertInto('scope_group_progress')
          .values({ vault_id: vaultId, generation: 0, ...values })
          .onConflict((oc) => oc.column('vault_id').doUpdateSet(values))
          .execute()
        progress = await tx
          .selectFrom('scope_group_progress')
          .selectAll()
          .where('vault_id', '=', vaultId)
          .executeTakeFirstOrThrow()
      }
      const decoded = BootstrapCursor.safeParse(parseGroupEvidenceJson(progress.bootstrap_cursor!))
      if (!decoded.success || progress.bootstrap_start_seq === null) throw groupUnavailable()
      const cursor = decoded.data
      const lease = await tx
        .selectFrom('scope_group_leases')
        .selectAll()
        .where('id', '=', cursor.lease)
        .where('vault_id', '=', vaultId)
        .where('start_seq', '=', progress.bootstrap_start_seq)
        .where('expires_at', '>', at.toISOString())
        .executeTakeFirst()
      if (!lease) throw groupUnavailable()
      let query = tx
        .selectFrom('files')
        .select(['id', 'head_version_id'])
        .where('vault_id', '=', vaultId)
        .orderBy('id')
        .limit(limit + 1)
      if (cursor.after !== null) query = query.where('id', '>', cursor.after)
      const rows = await query.execute(),
        batch = rows.slice(0, limit)
      const existingPins = await tx
        .selectFrom('scope_group_pins as pin')
        .innerJoin('scope_group_leases as lease', 'lease.id', 'pin.lease_id')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('pin.vault_id', '=', vaultId)
        .where('lease.expires_at', '>', at.toISOString())
        .executeTakeFirst()
      let pinCount = Number(existingPins?.count ?? 0)
      for (const file of batch) {
        const head = await headAtStart(tx, vaultId, file, progress.bootstrap_start_seq)
        if (!head) continue
        const chain: Array<{ id: string; prev_version_id: string | null; no: number; op: string }> =
            [],
          seen = new Set<string>()
        let id: string | null = head.id,
          complete = false
        for (let depth = 0; id !== null && depth < 128; depth++) {
          if (seen.has(id)) throw groupUnavailable()
          seen.add(id)
          const version = await tx
            .selectFrom('versions')
            .select(['id', 'prev_version_id', 'no', 'op'])
            .where('vault_id', '=', vaultId)
            .where('file_id', '=', file.id)
            .where('id', '=', id)
            .executeTakeFirst()
          if (!version) break
          chain.push(version)
          const already = await tx
            .selectFrom('scope_group_pins')
            .select('version_id')
            .where('lease_id', '=', lease.id)
            .where('version_id', '=', id)
            .executeTakeFirst()
          if (!already && ++pinCount > SCOPED_RESOURCE_LIMITS.groupPins) throw groupUnavailable()
          await tx
            .insertInto('scope_group_pins')
            .values({ lease_id: lease.id, vault_id: vaultId, file_id: file.id, version_id: id })
            .onConflict((oc) => oc.columns(['lease_id', 'version_id']).doNothing())
            .execute()
          if (
            version.prev_version_id === null &&
            (version.op === 'create' || version.op === 'conflict') &&
            version.no === 1
          ) {
            complete = true
            break
          }
          id = version.prev_version_id
        }
        if (complete)
          for (const version of chain.reverse())
            await processGroupVersion(tx, deps, vaultId, file.id, version.id, at.toISOString())
        else await processGroupVersion(tx, deps, vaultId, file.id, head.id, at.toISOString(), false)
      }
      const finished = rows.length <= limit
      await tx
        .updateTable('scope_group_progress')
        .set({
          bootstrap_cursor: finished
            ? 'complete'
            : JSON.stringify({ after: batch.at(-1)?.id ?? cursor.after, lease: lease.id }),
          processed_seq: finished ? progress.bootstrap_start_seq : progress.processed_seq,
          updated_at: at.toISOString(),
        })
        .where('vault_id', '=', vaultId)
        .execute()
      return {
        processed: batch.length,
        phase: finished ? ('replay' as const) : ('capture' as const),
      }
    })
  })
  // Throw only after the owner transaction has committed its failure marker.
  if ('error' in outcome) throw outcome.error
  return outcome.result
}
