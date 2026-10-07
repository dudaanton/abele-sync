import { PrincipalSchema } from '@abele/sync-protocol'
import type { Ctx, LoadedHead, NewVersion } from '../oplog/commitCtx.js'
import { fileKind } from '../oplog/kinds.js'
import {
  inheritedNamespaces,
  namespaceIsRestricted,
  pathSecurity,
  reduceSecurity,
  sourceNamespaces,
  type SecurityFacts,
} from './folderSecurity.js'

/** Resolve writer provenance from the authenticated request, never final merge/body metadata. */
async function writer(ctx: Ctx): Promise<{
  facet: 'device' | 'scoped' | 'system' | 'unknown'
  principal: string | null
  account: string | null
  grant: string | null
}> {
  const supplied = ctx.writer ? PrincipalSchema.parse(ctx.writer) : null
  if (
    supplied &&
    (supplied.facet === 'account' ||
      supplied.principal_id !== ctx.actor.id ||
      supplied.vault_id !== ctx.vaultId ||
      (supplied.facet === 'device' && ctx.actor.kind !== 'device') ||
      (supplied.facet === 'scoped' && ctx.actor.kind !== 'key'))
  )
    throw new Error('writer identity mismatch')
  if (supplied?.facet === 'device')
    return {
      facet: 'device',
      principal: supplied.principal_id,
      account: supplied.account_id,
      grant: null,
    }
  if (supplied?.facet === 'scoped')
    return {
      facet: 'scoped',
      principal: supplied.principal_id,
      account: supplied.account_id,
      grant: supplied.grant_id,
    }
  if (ctx.actor.kind === 'device') {
    const device = await ctx.trx
      .selectFrom('devices')
      .select('account_id')
      .where('id', '=', ctx.actor.id)
      .where('vault_id', '=', ctx.vaultId)
      .executeTakeFirst()
    if (device)
      return { facet: 'device', principal: ctx.actor.id, account: device.account_id, grant: null }
  }
  if (ctx.actor.kind === 'system')
    return { facet: 'system', principal: ctx.actor.id, account: null, grant: null }
  return { facet: 'unknown', principal: null, account: null, grant: null }
}
/** Bounded immutable facts for every actual version, including auxiliary/copy outputs.
 * Missing negative evidence stays unknown. Retained paths may prove positives only;
 * metadata reproving is a separate file-local preparation operation, not an owner commit scan.
 */
export async function recordVersionSecurity(
  ctx: Ctx,
  head: LoadedHead | null,
  v: NewVersion,
  versionId: string
): Promise<void> {
  const ids = [
    ...new Set(
      [
        head?.versionId,
        v.prevVersionId,
        v.merge?.head_version_id,
        v.merge?.base_version_id,
        ...(v.securitySourceVersionIds ?? []),
      ].filter((id): id is string => typeof id === 'string')
    ),
  ]
  if (ids.length > 8) throw new Error('security lineage exceeds the per-version bound')
  const options = { configurationDirectories: ctx.configurationDirectories }
  const recorded = ids.length
    ? await ctx.trx
        .selectFrom('version_security_sources')
        .select(['version_id', 'executable', 'settings', 'source_namespaces'])
        .where('vault_id', '=', ctx.vaultId)
        .where('version_id', 'in', ids)
        .execute()
    : []
  const byId = new Map<string, SecurityFacts>(
    recorded.map((row) => [
      row.version_id,
      {
        executable: row.executable,
        settings: sourceNamespaces(row.source_namespaces)?.some((root) =>
          namespaceIsRestricted([root], options)
        )
          ? 1
          : row.settings,
        source_namespaces: row.source_namespaces,
      },
    ])
  )
  if (ids.length) {
    const paths = await ctx.trx
      .selectFrom('versions')
      .select(['id', 'path'])
      .where('vault_id', '=', ctx.vaultId)
      .where('id', 'in', ids)
      .execute()
    for (const source of paths) {
      const positive = pathSecurity(source.path, fileKind(source.path, ctx.settings), options)
      const existing = byId.get(source.id)
      byId.set(source.id, {
        executable: positive.executable === 1 ? 1 : (existing?.executable ?? null),
        settings: positive.settings === 1 ? 1 : (existing?.settings ?? null),
        source_namespaces: existing?.source_namespaces ?? null,
      })
    }
  }
  const actor = await writer(ctx)
  const originalCreation =
    actor.facet !== 'unknown' &&
    v.op === 'create' &&
    v.no === 1 &&
    head === null &&
    ids.length === 0
  const facts = reduceSecurity(
    v.path,
    fileKind(v.path, ctx.settings),
    ids.map((id) => byId.get(id) ?? null),
    originalCreation,
    options
  )
  const namespaces = inheritedNamespaces(
    v.path,
    ids.map((id) => sourceNamespaces(byId.get(id)?.source_namespaces))
  )
  if (namespaces !== null && namespaceIsRestricted(namespaces, options)) facts.settings = 1
  else if (namespaces === null && facts.settings !== 1) facts.settings = null
  await ctx.trx
    .insertInto('version_security_sources')
    .values({
      version_id: versionId,
      vault_id: ctx.vaultId,
      file_id: v.fileId,
      writer_facet: actor.facet,
      writer_principal_id: actor.principal,
      writer_account_id: actor.account,
      writer_grant_id: actor.grant,
      executable: facts.executable,
      settings: facts.settings,
      source_version_ids: JSON.stringify(ids),
      source_namespaces: namespaces === null ? null : JSON.stringify(namespaces),
      recorded_at: ctx.at.toISOString(),
    })
    .execute()
}
