import { AbeleError, caseKey, type CommitOpResult } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import type { Ctx, LoadedHead } from '../oplog/commitCtx.js'
import { pathTakenFor } from '../oplog/commitHead.js'
import { fileKind } from '../oplog/kinds.js'
import { getVaultSettings } from '../vault/vaults.js'
import { authNow } from '../auth/accounts.js'
import { folderEligibility, pathSecurity, scopedSecurityEligibility } from './folderSecurity.js'
import type { ScopedAuthority } from './authority.js'
import type { ScopedMergeInputDeps } from './mergeInputs.js'
import { folderVersionInTransaction } from './admissions.js'
import { admitGroupOutput, groupSponsor } from './groups/writePolicy.js'
import { retainedNativeSponsor } from './nativeSponsor.js'
import { groupWriteCertificate, type GroupWriteAuthority } from './groups/writeCertificate.js'

export const denied = () => new AbeleError('not_found', 'authorized mutation is unavailable')
/** New identities may not enter another audience, including a preparing view.
 * Group membership is not ready yet: conservatively hold new identities rather
 * than invoking any parser or assuming that an uncertified group is empty.
 */
export async function destinationAllowed(
  ctx: Ctx,
  a: ScopedAuthority,
  path: string
): Promise<boolean> {
  if (ctx.authorizedDestinations?.has(path)) return true
  const facts = pathSecurity(path, fileKind(path, ctx.settings), {
    configurationDirectories: ctx.configurationDirectories,
  })
  const file = {
      path,
      kind: fileKind(path, ctx.settings),
      security: {
        ...facts,
        source_namespaces: JSON.stringify([path.includes('/') ? caseKey(path).split('/')[0] : '/']),
      },
    },
    options = { configurationDirectories: ctx.configurationDirectories }
  const sponsored = !!ctx.nativeSponsorId && file.kind !== 'note'
  if (sponsored) await groupSponsor(ctx, a, ctx.nativeSponsorId!)
  if (
    !(
      a.selector.kind === 'group' || sponsored
        ? scopedSecurityEligibility(file, options)
        : folderEligibility(a.prefix, file, options)
    ).eligible
  )
    return false
  const grants = await ctx.trx
    .selectFrom('scope_grants')
    .select(['id', 'selector_kind', 'folder_prefix'])
    .where('vault_id', '=', ctx.vaultId)
    .where('id', '!=', a.principal.grant_id)
    .where('revoked_at', 'is', null)
    .where('state', 'in', ['active', 'preparing'])
    .where((eb) =>
      eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', ctx.at.toISOString())])
    )
    .limit(65)
    .execute()
  if (grants.length > 64) return false
  if (grants.some((grant) => grant.selector_kind === 'group')) {
    const progress = await ctx.trx
      .selectFrom('scope_group_progress')
      .innerJoin('vault_seq', 'vault_seq.vault_id', 'scope_group_progress.vault_id')
      .select(['status', 'processed_seq', 'head_seq'])
      .where('scope_group_progress.vault_id', '=', ctx.vaultId)
      .executeTakeFirst()
    if (
      progress?.status !== 'ready' ||
      (progress.processed_seq !== progress.head_seq &&
        (a as GroupWriteAuthority)[groupWriteCertificate] !== true)
    ) {
      return false
    }
    // Initial discovery certified this fenced transaction; later head growth
    // before its release belongs to this same unit, not a concurrent writer.
    Object.assign(a, { [groupWriteCertificate]: true })
  }
  const allowed = !grants.some(
    (grant) =>
      grant.folder_prefix !== null && caseKey(path).startsWith(caseKey(grant.folder_prefix))
  )
  if (allowed) {
    ctx.authorizedDestinations ??= new Set()
    ctx.authorizedDestinations.add(path)
  }
  return allowed
}
/** Reuse the personal writer, substituting output authorization and principal accounting. */
export async function scopedOutputContext(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  deps: ScopedMergeInputDeps,
  sponsorId?: string,
  nativeFileId?: string
): Promise<Ctx> {
  const ctx: Ctx = {
    trx: tx,
    store: deps.store,
    vaultId: a.principal.vault_id,
    actor: { kind: 'key', id: a.principal.principal_id, name: 'Scoped editor' },
    writer: a.principal,
    settings: await getVaultSettings({ db: tx }, a.principal.vault_id),
    at: authNow(deps),
    configurationDirectories:
      deps.configurationDirectories ?? deps.config?.configurationDirectories,
    scopedWriter: true,
    nativeSponsorId: sponsorId,
  }
  if (!sponsorId && nativeFileId) {
    sponsorId = await retainedNativeSponsor(ctx, a, nativeFileId)
    ctx.nativeSponsorId = sponsorId
  }
  ctx.conflictDestination = async (wanted) => {
    if (a.selector.kind === 'group' && !ctx.allowGroupConflictCopy) return null
    if (!(await destinationAllowed(ctx, a, wanted))) return null
    // Do not rename a generated copy around hidden collisions or reveal a suffix count.
    const probe = { fileId: '', path: wanted } as LoadedHead
    try {
      return (await pathTakenFor(
        ctx,
        { op: 'move', file_id: '', base_version_id: '', to_path: wanted },
        probe
      ))
        ? null
        : wanted
    } catch (error) {
      if (error instanceof AbeleError && error.code === 'path_taken') return null
      throw error
    }
  }
  ctx.restoreDestination = async (wanted) => {
    if (!(await destinationAllowed(ctx, a, wanted))) throw denied()
    const probe = { fileId: '', path: wanted } as LoadedHead
    if (
      await pathTakenFor(
        ctx,
        { op: 'move', file_id: '', base_version_id: '', to_path: wanted },
        probe
      )
    )
      throw denied()
    return wanted
  }
  ctx.authorizeOutput = async (v, versionId) => {
    const security = await tx
      .selectFrom('version_security_sources')
      .selectAll()
      .where('version_id', '=', versionId)
      .where('vault_id', '=', ctx.vaultId)
      .executeTakeFirst()
    if (
      !scopedSecurityEligibility(
        { path: v.path, kind: fileKind(v.path, ctx.settings), security },
        { configurationDirectories: ctx.configurationDirectories }
      ).eligible
    )
      throw denied()
    if (nativeFileId && sponsorId && v.fileId !== nativeFileId) throw denied()
    if (v.no === 1) {
      if (!(await destinationAllowed(ctx, a, v.path))) throw denied()
      const kind = fileKind(v.path, ctx.settings)
      if (kind !== 'note' && kind !== 'canvas' && kind !== 'attachment') throw denied()
      await tx
        .insertInto('scope_native_files')
        .values({
          grant_id: a.principal.grant_id,
          vault_id: ctx.vaultId,
          file_id: v.fileId,
          creator_kind: a.principal.kind,
          creator_id: a.principal.principal_id,
          created_version_id: versionId,
          kind,
          created_at: ctx.at.toISOString(),
        })
        .execute()
    }
    if (a.selector.kind === 'group' || sponsorId)
      await admitGroupOutput(ctx, a, v, versionId, sponsorId)
  }
  return ctx
}
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never
export type ScopedWriteResult = WithoutSeq<
  Extract<CommitOpResult, { status: 'applied' | 'merged' | 'conflict' }>
>
export type ScopedAcknowledgement = { status: 'acknowledged'; file_id: string; version_id: string }
export async function serializeScopedResult(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  deps: ScopedMergeInputDeps,
  result: CommitOpResult
): Promise<ScopedWriteResult | ScopedAcknowledgement> {
  if (result.status === 'rejected') throw new AbeleError(result.code, 'scoped operation refused')
  try {
    await folderVersionInTransaction(tx, a, result.file_id, result.version_id, authNow(deps), deps)
  } catch (error) {
    if (!(
      error instanceof AbeleError &&
      error.code === 'not_found' &&
      result.status === 'applied' &&
      result.sha === null
    ))
      throw error
    // A just-authorized genuine deletion can have no retained trash at all.
    // Its compact outcome contains no newly forbidden path, bytes or history.
    const deleted = await tx
      .selectFrom('versions')
      .select('id')
      .where('vault_id', '=', a.principal.vault_id)
      .where('file_id', '=', result.file_id)
      .where('id', '=', result.version_id)
      .where('op', '=', 'delete')
      .executeTakeFirst()
    if (!deleted) throw error
    return { status: 'acknowledged', file_id: result.file_id, version_id: result.version_id }
  }
  if (result.status === 'conflict')
    await folderVersionInTransaction(
      tx,
      a,
      result.conflict_file_id,
      result.conflict_version_id,
      authNow(deps),
      deps
    )
  const { seq: _private, ...safe } = result
  return safe
}
