import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { getVaultSettings } from '../vault/vaults.js'
import { fileKind } from '../oplog/kinds.js'
import {
  folderEligibility,
  scopedSecurityEligibility,
  type FolderFile,
  type SecurityOptions,
} from './folderSecurity.js'

export interface AdmissionOptions extends SecurityOptions {
  config?: SecurityOptions
}
export async function folderReasons(
  db: Kysely<Database>,
  grant: { id: string; folder_prefix: string | null },
  file: { id: string; vault_id: string } & FolderFile,
  at: Date,
  options: SecurityOptions,
  certifiedGroupWrite = false
) {
  const intrinsic =
    grant.folder_prefix !== null && folderEligibility(grant.folder_prefix, file, options).eligible
  if (intrinsic) return { eligible: true, intrinsic: true }
  // An extra bypasses only the folder prefix, never security/configuration policy.
  const safe = scopedSecurityEligibility(file, options).eligible
  if (!safe || file.kind === 'settings' || file.kind === 'script')
    return { eligible: false, intrinsic: false }
  if (grant.folder_prefix === null) {
    const progress = await db
      .selectFrom('scope_group_progress')
      .innerJoin('vault_seq', 'vault_seq.vault_id', 'scope_group_progress.vault_id')
      .select(['processed_seq', 'head_seq', 'status'])
      .where('scope_group_progress.vault_id', '=', file.vault_id)
      .executeTakeFirst()
    if (
      !certifiedGroupWrite &&
      (!progress || progress.status !== 'ready' || progress.processed_seq !== progress.head_seq)
    )
      return { eligible: false, intrinsic: false }
    const member = await db
      .selectFrom('scope_current_members as member')
      .innerJoin('scope_admission_intervals as interval', 'interval.id', 'member.interval_id')
      .select('member.file_id')
      .where('member.grant_id', '=', grant.id)
      .where('member.file_id', '=', file.id)
      .where('interval.intrinsic', '=', 1)
      .where('interval.ended_at', 'is', null)
      .executeTakeFirst()
    const trash = member
      ? undefined
      : await db
          .selectFrom('scope_trash as trash')
          .innerJoin('scope_admission_intervals as interval', 'interval.id', 'trash.interval_id')
          .select('trash.file_id')
          .where('trash.grant_id', '=', grant.id)
          .where('trash.file_id', '=', file.id)
          .where('trash.eligible', '=', 1)
          .where('trash.expires_at', '>', at.toISOString())
          .where('interval.intrinsic', '=', 1)
          .executeTakeFirst()
    if (member || trash) return { eligible: true, intrinsic: true }
  }
  const sponsors = await db
    .selectFrom('scope_extra_entries as entry')
    .innerJoin('scope_extra_sponsors as sponsor', 'sponsor.entry_id', 'entry.id')
    .innerJoin('scope_admission_intervals as interval', 'interval.id', 'sponsor.interval_id')
    .innerJoin('scope_current_members as note', 'note.interval_id', 'interval.id')
    .select(['sponsor.note_id', 'note.version_id'])
    .where('entry.grant_id', '=', grant.id)
    .where('entry.vault_id', '=', file.vault_id)
    .where('entry.file_id', '=', file.id)
    .where('entry.withdrawn_at', 'is', null)
    .where('interval.ended_at', 'is', null)
    .where('interval.intrinsic', '=', 1)
    .whereRef('interval.generation', '=', 'sponsor.admission_generation')
    .where('note.kind', '=', 'note')
    .limit(65)
    .execute()
  if (sponsors.length > 64) return { eligible: false, intrinsic: false }
  for (const sponsor of sponsors) {
    const source = await versionFolderFile(db, file.vault_id, sponsor.note_id, sponsor.version_id)
    if (
      source &&
      (grant.folder_prefix !== null
        ? folderEligibility(grant.folder_prefix, source.file, options).eligible
        : scopedSecurityEligibility(source.file, options).eligible)
    )
      return { eligible: true, intrinsic: false }
  }
  return { eligible: false, intrinsic: false }
}
export async function versionFolderFile(
  db: Kysely<Database>,
  vaultId: string,
  fileId: string,
  versionId: string
) {
  const version = await db
    .selectFrom('versions')
    .selectAll()
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', fileId)
    .where('id', '=', versionId)
    .executeTakeFirst()
  if (!version) return null
  const security = await db
    .selectFrom('version_security_sources')
    .selectAll()
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', fileId)
    .where('version_id', '=', versionId)
    .executeTakeFirst()
  const settings = await getVaultSettings({ db }, vaultId)
  return {
    version,
    file: {
      id: fileId,
      vault_id: vaultId,
      path: version.path,
      kind: fileKind(version.path, settings),
      security: security ?? null,
    },
  }
}
