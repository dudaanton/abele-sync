import { AbeleError, AssetViewSchema, type AssetView } from '@abele/sync-protocol'
import { sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { authenticateDevice } from '../auth/devices.js'
import { authNow } from '../auth/accounts.js'
import { liveAt } from '../auth/freshOwner.js'
import { withVaultLock } from '../oplog/lock.js'
import { lockAccounts } from '../auth/accountFence.js'
import { versionFolderFile } from './admissionPolicy.js'
import { scopedSecurityEligibility } from './folderSecurity.js'
import type { ScopedUploadDeps } from './uploads.js'
export type AssetDeps = ScopedUploadDeps
export async function assetGrant(
  tx: Transaction<Database>,
  deps: AssetDeps,
  vault: string,
  grant: string
) {
  let query = tx
    .selectFrom('scope_grants')
    .selectAll()
    .where('vault_id', '=', vault)
    .where('id', '=', grant)
  if (deps.dialect === 'pg') query = query.forUpdate()
  const row = await query.executeTakeFirst(),
    at = authNow(deps)
  if (!row || row.revoked_at !== null || !liveAt(row.expires_at, at))
    throw new AbeleError('not_found', 'no live grant')
  if (row.selector_kind === 'group') {
    const progress = await tx
      .selectFrom('scope_group_progress')
      .innerJoin('vault_seq', 'vault_seq.vault_id', 'scope_group_progress.vault_id')
      .select(['status', 'processed_seq', 'head_seq'])
      .where('scope_group_progress.vault_id', '=', vault)
      .executeTakeFirst()
    if (!progress || progress.status !== 'ready' || progress.processed_seq !== progress.head_seq)
      throw new AbeleError('scope_updating', 'group publication view is updating')
  }
  return row
}
export async function withOwnerDevice<T>(
  deps: AssetDeps,
  token: string,
  vault: string,
  grant: string,
  run: (
    tx: Transaction<Database>,
    device: Awaited<ReturnType<typeof authenticateDevice>>,
    row: Awaited<ReturnType<typeof assetGrant>>
  ) => Promise<T>
) {
  const first = await authenticateDevice(deps, token)
  if (first.vaultId !== vault)
    throw new AbeleError('forbidden', 'the actual owner device is required')
  return withVaultLock(
    deps.db,
    deps.dialect,
    vault,
    async (tx) => {
      // A final SELECT alone leaves a pre-COMMIT revoke window. Every device
      // revoke UPDATE conflicts with this row lock, independent of last_seen.
      if (deps.dialect === 'pg')
        await tx
          .selectFrom('devices')
          .select('id')
          .where('id', '=', first.deviceId)
          .forUpdate()
          .executeTakeFirst()
      const bound = { ...deps, db: tx },
        device = await authenticateDevice(bound, token),
        row = await assetGrant(tx, deps, vault, grant)
      const owner = await tx
        .selectFrom('vaults')
        .select('owner_account_id')
        .where('id', '=', vault)
        .executeTakeFirstOrThrow()
      if (
        device.deviceId !== first.deviceId ||
        device.vaultId !== vault ||
        device.accountId !== owner.owner_account_id ||
        row.owner_account_id !== owner.owner_account_id
      )
        throw new AbeleError('forbidden', 'the actual owner device is required')
      const result = await run(tx, device, row)
      await authenticateDevice(bound, token)
      if (!liveAt(row.expires_at, authNow(deps)))
        throw new AbeleError('unauthorized', 'grant expired')
      return result
    },
    (tx) => lockAccounts(tx, [first.accountId])
  )
}
export async function publicationGeneration(tx: Transaction<Database>, grant: string) {
  const row = await tx
    .selectFrom('scope_extra_entries')
    .select((eb) =>
      eb.fn.coalesce(eb.fn.max<number>('withdrawal_generation'), sql<number>`0`).as('generation')
    )
    .where('grant_id', '=', grant)
    .executeTakeFirst()
  return Number(row?.generation ?? 0)
}
export async function intrinsicSponsor(
  tx: Transaction<Database>,
  deps: AssetDeps,
  grant: string,
  vault: string,
  input: { fileId: string; versionId: string; admissionGeneration: number }
) {
  const note = await tx
    .selectFrom('scope_current_members as note')
    .innerJoin('scope_admission_intervals as interval', 'interval.id', 'note.interval_id')
    .select(['note.file_id', 'note.version_id', 'note.interval_id', 'interval.generation'])
    .where('note.grant_id', '=', grant)
    .where('note.vault_id', '=', vault)
    .where('note.file_id', '=', input.fileId)
    .where('note.kind', '=', 'note')
    .where('interval.intrinsic', '=', 1)
    .where('interval.ended_at', 'is', null)
    .executeTakeFirst()
  const file = await tx
    .selectFrom('files')
    .select('head_version_id')
    .where('vault_id', '=', vault)
    .where('id', '=', input.fileId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  const source = note ? await versionFolderFile(tx, vault, note.file_id, note.version_id) : null
  if (
    !note ||
    !file ||
    note.version_id !== input.versionId ||
    file.head_version_id !== input.versionId ||
    note.generation !== input.admissionGeneration ||
    !source ||
    !scopedSecurityEligibility(source.file, {
      configurationDirectories:
        deps.configurationDirectories ?? deps.config?.configurationDirectories,
    }).eligible
  )
    throw new AbeleError('conflict', 'sponsor admission changed')
  return note
}
export async function assetView(
  tx: Transaction<Database>,
  deps: AssetDeps,
  vault: string,
  grant: string,
  scoped = false,
  effectiveRole?: 'reader' | 'editor'
): Promise<AssetView> {
  const row = await assetGrant(tx, deps, vault, grant),
    entries: AssetView['entries'] = []
  const assets = await tx
    .selectFrom('scope_extra_entries')
    .selectAll()
    .where('grant_id', '=', grant)
    .where('vault_id', '=', vault)
    .where('withdrawn_at', 'is', null)
    .limit(1001)
    .execute()
  if (assets.length > 1000) throw new AbeleError('too_large', 'asset list bound reached')
  for (const asset of assets) {
    const file = await tx
      .selectFrom('files')
      .select('head_version_id')
      .where('id', '=', asset.file_id)
      .where('vault_id', '=', vault)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    const source = file?.head_version_id
      ? await versionFolderFile(tx, vault, asset.file_id, file.head_version_id)
      : null
    if (
      !source?.version.blob_sha ||
      !scopedSecurityEligibility(source.file, {
        configurationDirectories:
          deps.configurationDirectories ?? deps.config?.configurationDirectories,
      }).eligible
    )
      continue
    if (
      scoped &&
      !(await tx
        .selectFrom('scope_current_members')
        .select('file_id')
        .where('grant_id', '=', grant)
        .where('file_id', '=', asset.file_id)
        .executeTakeFirst())
    )
      continue
    const rows = await tx
        .selectFrom('scope_extra_sponsors')
        .select(['note_id', 'admission_generation'])
        .where('entry_id', '=', asset.id)
        .limit(65)
        .execute(),
      sponsors: AssetView['entries'][number]['sponsors'] = []
    if (rows.length > 64) throw new AbeleError('scope_unavailable', 'sponsor list bound reached')
    for (const item of rows) {
      const member = await tx
        .selectFrom('scope_current_members')
        .select('version_id')
        .where('grant_id', '=', grant)
        .where('file_id', '=', item.note_id)
        .executeTakeFirst()
      if (!member) continue
      try {
        await intrinsicSponsor(tx, deps, grant, vault, {
          fileId: item.note_id,
          versionId: member.version_id,
          admissionGeneration: item.admission_generation,
        })
        sponsors.push({
          fileId: item.note_id,
          versionId: member.version_id,
          admissionGeneration: item.admission_generation,
          inScope: true,
          intrinsic: true,
        })
      } catch (error) {
        if (!(error instanceof AbeleError && error.code === 'conflict')) throw error
      }
    }
    if (sponsors.length)
      entries.push({
        target: {
          fileId: asset.file_id,
          versionId: source.version.id,
          sha: source.version.blob_sha,
          path: source.version.path,
          eligible: true,
        },
        sponsors,
        reason: asset.reason ?? 'native_create',
        kind: asset.origin === 'owner' ? 'owner-extra' : 'native-asset',
      })
  }
  return AssetViewSchema.parse({
    grantId: grant,
    revision: row.publication_revision,
    withdrawalGeneration: await publicationGeneration(tx, grant),
    active: row.state === 'active',
    role: effectiveRole ?? row.role,
    entries,
  })
}
