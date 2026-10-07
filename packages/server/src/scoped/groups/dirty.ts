import type { Ctx, NewVersion } from '../../oplog/commitCtx.js'
import { newId } from '../../ids.js'
import { setGroupAdmissionStart } from './grantBaseline.js'
import { SCOPED_RESOURCE_LIMITS } from '../resourceLimits.js'
/** Only called after the existing bounded grant query proves a live/preparing group.
 * No content reads, parser, graph scan or unresolved-reference processing here.
 */
export async function appendGroupEvidence(ctx: Ctx, v: NewVersion, versionId: string) {
  const written = await ctx.trx
    .selectFrom('versions')
    .select('seq')
    .where('id', '=', versionId)
    .executeTakeFirstOrThrow()
  const unbased = await ctx.trx
    .selectFrom('scope_grants as grant')
    .leftJoin('scope_folder_preparations as baseline', 'baseline.grant_id', 'grant.id')
    .select('grant.id')
    .where('grant.vault_id', '=', ctx.vaultId)
    .where('grant.selector_kind', '=', 'group')
    .where('grant.revoked_at', 'is', null)
    .where('baseline.grant_id', 'is', null)
    .limit(65)
    .execute()
  if (unbased.length > 64) throw new Error('group baseline bound reached')
  for (const grant of unbased) {
    if (
      await ctx.trx
        .selectFrom('scope_current_members')
        .select('file_id')
        .where('grant_id', '=', grant.id)
        .limit(1)
        .executeTakeFirst()
    )
      throw new Error('missing group baseline requires reviewed recovery')
    await setGroupAdmissionStart(ctx.trx, ctx.vaultId, grant.id, written.seq - 1, ctx.at)
  }
  const progress = await ctx.trx
    .selectFrom('scope_group_progress')
    .select(['processed_seq', 'status'])
    .where('vault_id', '=', ctx.vaultId)
    .executeTakeFirst()
  if (progress?.status === 'unavailable') return
  const pending = progress
    ? await ctx.trx
        .selectFrom('scope_group_dirty')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('vault_id', '=', ctx.vaultId)
        .where('committed_seq', '>', progress.processed_seq)
        .executeTakeFirst()
    : null
  const livePins = await ctx.trx
    .selectFrom('scope_group_pins as pin')
    .innerJoin('scope_group_leases as lease', 'lease.id', 'pin.lease_id')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('pin.vault_id', '=', ctx.vaultId)
    .where('lease.expires_at', '>', ctx.at.toISOString())
    .executeTakeFirst()
  if (
    Number(pending?.count ?? 0) >= SCOPED_RESOURCE_LIMITS.pendingGroupVersions ||
    // New head + predecessor + the at-most-eight retained lineage sources.
    Number(livePins?.count ?? 0) + 10 > SCOPED_RESOURCE_LIMITS.groupPins
  ) {
    // Durable gap marker bounds backlog without making a parser/resource hold
    // fail a personal save. Public group reads cannot use this certificate.
    await ctx.trx
      .updateTable('scope_group_progress')
      .set({ status: 'unavailable', updated_at: ctx.at.toISOString() })
      .where('vault_id', '=', ctx.vaultId)
      .execute()
    return
  }
  const facts = await ctx.trx
    .selectFrom('version_security_sources')
    .selectAll()
    .where('version_id', '=', versionId)
    .executeTakeFirstOrThrow()
  const ids: unknown = JSON.parse(facts.source_version_ids)
  if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => typeof id !== 'string'))
    throw new Error('invalid group lineage evidence')
  const sourceIds = ids as string[],
    at = ctx.at.toISOString()
  const sources = sourceIds.length
    ? await ctx.trx
        .selectFrom('versions')
        .select(['id', 'file_id', 'blob_sha', 'path', 'seq'])
        .where('vault_id', '=', ctx.vaultId)
        .where('id', 'in', sourceIds)
        .execute()
    : []
  const lineage = {
    version: { id: versionId, seq: written.seq, ...v },
    writer: facts,
    sourceIds,
    sources,
    complete: sources.length === sourceIds.length,
  }
  const body = JSON.stringify(lineage)
  if (Buffer.byteLength(body) > 65536) throw new Error('group dirty evidence bound reached')
  await ctx.trx
    .insertInto('scope_group_dirty')
    .values({
      vault_id: ctx.vaultId,
      committed_seq: written.seq,
      ordinal: 0,
      file_id: v.fileId,
      version_id: versionId,
      operation: v.op,
      lineage: body,
      created_at: at,
    })
    .execute()
  await ctx.trx
    .insertInto('scope_group_progress')
    .values({
      vault_id: ctx.vaultId,
      processed_seq: written.seq - 1,
      generation: 0,
      bootstrap_start_seq: written.seq - 1,
      bootstrap_cursor: null,
      status: 'preparing',
      updated_at: at,
    })
    .onConflict((oc) => oc.column('vault_id').doNothing())
    .execute()
  let lease = await ctx.trx
    .selectFrom('scope_group_leases')
    .select('id')
    .where('vault_id', '=', ctx.vaultId)
    .where('expires_at', '>', at)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!lease) {
    lease = { id: newId() }
    await ctx.trx
      .insertInto('scope_group_leases')
      .values({
        id: lease.id,
        vault_id: ctx.vaultId,
        start_seq: written.seq - 1,
        created_at: at,
        expires_at: new Date(ctx.at.getTime() + 5 * 60 * 1000).toISOString(),
      })
      .execute()
  }
  const pins = [
    { id: versionId, file_id: v.fileId },
    ...sources.map((source) => ({ id: source.id, file_id: source.file_id })),
  ]
  for (const pin of pins)
    await ctx.trx
      .insertInto('scope_group_pins')
      .values({
        lease_id: lease.id,
        vault_id: ctx.vaultId,
        file_id: pin.file_id,
        version_id: pin.id,
      })
      .onConflict((oc) => oc.columns(['lease_id', 'version_id']).doNothing())
      .execute()
}
