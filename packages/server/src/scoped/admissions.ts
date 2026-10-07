import { AbeleError } from '@abele/sync-protocol'
import type { Kysely, Transaction } from 'kysely'
import { authNow } from '../auth/accounts.js'
import type { Database } from '../db/schema.js'
import { fileKind } from '../oplog/kinds.js'
import type { Ctx, NewVersion } from '../oplog/commitCtx.js'
import { scopedSecurityEligibility, type SecurityOptions } from './folderSecurity.js'
import { withScopedAuthority, type ScopedAuthority, type ScopedDeps } from './authority.js'
import { applyFolderAdmission, type AdmittedInput } from './admissionState.js'
import { folderReasons, versionFolderFile, type AdmissionOptions } from './admissionPolicy.js'
import { appendGroupEvidence } from './groups/dirty.js'
import { groupWriteCertificate, type GroupWriteAuthority } from './groups/writeCertificate.js'

export { prepareFolderAdmissions, FOLDER_BOOTSTRAP_LIMIT } from './folderPreparation.js'
const missing = () => new AbeleError('not_found', 'no admitted version')
const options = (deps: AdmissionOptions) => ({
  configurationDirectories: deps.configurationDirectories ?? deps.config?.configurationDirectories,
})
/** Called for every written version while the existing personal commit holds its vault lock.
 * Only folder grant rows and this identity/path are considered; no inventory/parser work.
 */
export async function recordFolderVersion(
  ctx: Ctx,
  v: NewVersion,
  versionId: string
): Promise<void> {
  const grants = await ctx.trx
    .selectFrom('scope_grants')
    .select(['id', 'folder_prefix', 'selector_kind'])
    .where('vault_id', '=', ctx.vaultId)
    .where('revoked_at', 'is', null)
    .where((eb) =>
      eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', ctx.at.toISOString())])
    )
    .limit(64)
    .execute()
  if (!grants.length) return
  // Reuse this existing grant query; no extra discovery query or parser work on
  // no-grant/folder-only versions, including independent PostgreSQL writers.
  if (grants.some((grant) => grant.selector_kind === 'group'))
    await appendGroupEvidence(ctx, v, versionId)
  if (!grants.some((grant) => grant.selector_kind === 'folder')) return
  const security = await ctx.trx
    .selectFrom('version_security_sources')
    .selectAll()
    .where('vault_id', '=', ctx.vaultId)
    .where('version_id', '=', versionId)
    .executeTakeFirst()
  const file: AdmittedInput = {
    id: v.fileId,
    vault_id: ctx.vaultId,
    versionId,
    path: v.path,
    kind: fileKind(v.path, ctx.settings),
    security: security ?? null,
    sha: v.sha,
    size: v.size,
    mtime: v.mtime,
    deleted: v.op === 'delete',
  }
  for (const grant of grants) {
    if (grant.selector_kind !== 'folder') continue
    const running = await ctx.trx
      .selectFrom('scope_folder_preparations')
      .select('phase')
      .where('grant_id', '=', grant.id)
      .executeTakeFirst()
    if (running && running.phase !== 'complete') continue
    await applyFolderAdmission(ctx.trx, grant, file, ctx.at, {
      configurationDirectories: ctx.configurationDirectories,
    })
  }
}
/** Explicit security reproof reconciles only this current identity, not the vault. */
export async function reconcileFolderFile(
  tx: Transaction<Database>,
  vaultId: string,
  fileId: string,
  at: Date,
  opts: SecurityOptions
): Promise<void> {
  const file = await tx
    .selectFrom('files')
    .select(['head_version_id', 'deleted_at'])
    .where('vault_id', '=', vaultId)
    .where('id', '=', fileId)
    .executeTakeFirst()
  if (!file?.head_version_id) return
  const source = await versionFolderFile(tx, vaultId, fileId, file.head_version_id)
  if (!source) return
  const grants = await tx
    .selectFrom('scope_grants')
    .select(['id', 'folder_prefix'])
    .where('vault_id', '=', vaultId)
    .where('selector_kind', '=', 'folder')
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())]))
    .limit(64)
    .execute()
  for (const grant of grants)
    await applyFolderAdmission(
      tx,
      grant,
      {
        ...source.file,
        versionId: source.version.id,
        sha: source.version.blob_sha,
        size: source.version.size,
        mtime: source.version.mtime,
        deleted: file.deleted_at !== null,
      },
      at,
      opts
    )
}

/** One common interval/security predicate for later byte/history/snapshot adapters. It never
 * grants access from an older interval, private base, retained payload or guessed identity.
 */
export async function folderVersionInTransaction(
  db: Kysely<Database>,
  a: Pick<ScopedAuthority, 'selector' | 'prefix'> & {
    principal: Pick<ScopedAuthority['principal'], 'grant_id' | 'vault_id'>
  },
  fileId: string,
  versionId: string,
  at: Date,
  opts: AdmissionOptions = {}
) {
  const admission = await db
    .selectFrom('scope_version_admissions as admitted')
    .innerJoin('scope_admission_intervals as interval', 'interval.id', 'admitted.interval_id')
    .select([
      'admitted.interval_id',
      'admitted.generation',
      'interval.ended_at',
      'interval.end_reason',
    ])
    .where('admitted.grant_id', '=', a.principal.grant_id)
    .where('admitted.vault_id', '=', a.principal.vault_id)
    .where('admitted.file_id', '=', fileId)
    .where('admitted.version_id', '=', versionId)
    // The same unchanged baseline may be explicitly re-admitted after repair/root change.
    // Consult its newest generation, never the first historical match.
    .orderBy('interval.generation', 'desc')
    .executeTakeFirst()
  if (!admission) throw missing()
  if (admission.ended_at !== null) {
    const trash =
      admission.end_reason === 'deleted'
        ? await db
            .selectFrom('scope_trash')
            .select('interval_id')
            .where('grant_id', '=', a.principal.grant_id)
            .where('file_id', '=', fileId)
            .where('interval_id', '=', admission.interval_id)
            .where('eligible', '=', 1)
            .where('expires_at', '>', at.toISOString())
            .executeTakeFirst()
        : undefined
    if (!trash) throw missing()
  }
  const source = await versionFolderFile(db, a.principal.vault_id, fileId, versionId)
  // The historical version must be safe in its own right. Its former path is not
  // today's authority ground: an extra may have moved into the folder without
  // closing the interval, then lost its sponsor. Check the current head instead.
  if (!source || !scopedSecurityEligibility(source.file, options(opts)).eligible) throw missing()
  if (admission.ended_at !== null) {
    const file = await db
      .selectFrom('files')
      .select('head_version_id')
      .where('vault_id', '=', a.principal.vault_id)
      .where('id', '=', fileId)
      .executeTakeFirst()
    const currentGround = file?.head_version_id
      ? await versionFolderFile(db, a.principal.vault_id, fileId, file.head_version_id)
      : null
    if (
      !currentGround ||
      !(
        await folderReasons(
          db,
          {
            id: a.principal.grant_id,
            folder_prefix: a.selector.kind === 'folder' ? a.prefix : null,
          },
          currentGround.file,
          at,
          options(opts),
          (a as GroupWriteAuthority)[groupWriteCertificate] === true
        )
      ).eligible
    )
      throw missing()
  }
  if (admission.ended_at === null) {
    const current = await db
      .selectFrom('scope_current_members')
      .select(['version_id', 'path', 'kind', 'interval_id'])
      .where('grant_id', '=', a.principal.grant_id)
      .where('vault_id', '=', a.principal.vault_id)
      .where('file_id', '=', fileId)
      .where('interval_id', '=', admission.interval_id)
      .executeTakeFirst()
    if (!current) throw missing()
    const nowFile = await versionFolderFile(db, a.principal.vault_id, fileId, current.version_id)
    if (
      !nowFile ||
      !(
        await folderReasons(
          db,
          {
            id: a.principal.grant_id,
            folder_prefix: a.selector.kind === 'folder' ? a.prefix : null,
          },
          nowFile.file,
          at,
          options(opts),
          (a as GroupWriteAuthority)[groupWriteCertificate] === true
        )
      ).eligible
    )
      throw missing()
  }
  return {
    file_id: fileId,
    version_id: versionId,
    interval_id: admission.interval_id,
    generation: admission.generation,
  }
}
export async function requireFolderVersion(
  deps: ScopedDeps & AdmissionOptions,
  token: string,
  vaultId: string,
  grantId: string,
  fileId: string,
  versionId: string
) {
  return withScopedAuthority(deps, token, vaultId, grantId, 'read', (tx, a) =>
    folderVersionInTransaction(tx, a, fileId, versionId, authNow(deps), deps)
  )
}
