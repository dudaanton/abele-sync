import { AbeleError } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { applyFolderAdmission } from '../admissionState.js'
import { versionFolderFile } from '../admissionPolicy.js'
import { scopedSecurityEligibility, type SecurityOptions } from '../folderSecurity.js'
import type { GroupOriginState } from './origins.js'
import { readAudienceApproval } from './audienceApproval.js'
import { parseGroupState } from './versionFacts.js'
const unavailable = () => new AbeleError('scope_unavailable', 'group view evidence unavailable')
/** Project one certified intermediate watermark using indexed bound-target
 * reverse relations. No parsing, basename resolution or whole-vault inventory scan.
 */
export async function publishGroupViews(
  tx: Transaction<Database>,
  vaultId: string,
  seq: number,
  at: Date,
  options: SecurityOptions = {}
) {
  const grants = await tx
    .selectFrom('scope_grants')
    .select(['id', 'root_file_id', 'owner_account_id'])
    .where('vault_id', '=', vaultId)
    .where('selector_kind', '=', 'group')
    .where('revoked_at', 'is', null)
    .where('state', 'in', ['preparing', 'active'])
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())]))
    .limit(65)
    .execute()
  if (grants.length > 64) throw unavailable()
  const cache = new Map<string, Awaited<ReturnType<typeof versionFolderFile>>>()
  const versionAt = async (fileId: string) => {
    if (cache.has(fileId)) return cache.get(fileId)!
    const fact = await tx
      .selectFrom('scope_group_parse_facts')
      .select('version_id')
      .where('vault_id', '=', vaultId)
      .where('file_id', '=', fileId)
      .where('committed_seq', '<=', seq)
      .orderBy('committed_seq', 'desc')
      .limit(1)
      .executeTakeFirst()
    const source = fact ? await versionFolderFile(tx, vaultId, fileId, fact.version_id) : null
    cache.set(fileId, source)
    return source
  }
  const memoryFor = async (fileId: string, versionId: string): Promise<GroupOriginState | null> => {
    const fact = await tx
      .selectFrom('scope_group_parse_facts')
      .select(['status', 'facts'])
      .where('vault_id', '=', vaultId)
      .where('file_id', '=', fileId)
      .where('version_id', '=', versionId)
      .executeTakeFirst()
    if (!fact) return null
    const state = parseGroupState(fact.facts)
    return fact.status === 'valid' ? state : null
  }
  for (const grant of grants) {
    if (!grant.root_file_id) throw unavailable()
    const baseline = await tx
      .selectFrom('scope_folder_preparations')
      .select('start_seq')
      .where('grant_id', '=', grant.id)
      .where('vault_id', '=', vaultId)
      .executeTakeFirst()
    if (!baseline) throw unavailable()
    // A newly created/renewed audience must not admit queued pre-entry versions.
    if (seq < baseline.start_seq) continue
    const approved = await tx
      .selectFrom('scope_group_anchors')
      .select('file_id')
      .where('vault_id', '=', vaultId)
      .where('grant_id', '=', grant.id)
      .where('owner_account_id', '=', grant.owner_account_id)
      .limit(1001)
      .execute()
    if (approved.length > 1000) throw unavailable()
    const anchors = new Set([grant.root_file_id, ...approved.map((row) => row.file_id)]),
      members = new Set<string>(),
      queue: string[] = [],
      seen = new Set<string>()
    const root = await versionAt(grant.root_file_id)
    const safe = (source: Awaited<ReturnType<typeof versionFolderFile>>) =>
      source !== null &&
      source.file.kind === 'note' &&
      scopedSecurityEligibility(source.file, options).eligible
    if (safe(root) && root!.version.op !== 'delete') {
      members.add(grant.root_file_id)
      queue.push(grant.root_file_id)
    }
    for (let index = 0; index < queue.length; index++) {
      const anchor = queue[index]!
      if (seen.has(anchor)) continue
      seen.add(anchor)
      const incoming = await tx
        .selectFrom('scope_group_bindings')
        .select([
          'source_file_id',
          'token_key',
          'target_file_id',
          'origin_id',
          'approved_rebind_id',
        ])
        .where('vault_id', '=', vaultId)
        .where('target_file_id', '=', anchor)
        .where('state', '=', 'bound')
        .limit(100001)
        .execute()
      if (incoming.length > 100000) throw unavailable()
      for (const binding of incoming) {
        const source = await versionAt(binding.source_file_id)
        if (!safe(source)) continue
        let versionId = source!.version.id
        if (source!.version.op === 'delete') {
          const trash = await tx
            .selectFrom('scope_trash')
            .select('last_version_id')
            .where('grant_id', '=', grant.id)
            .where('file_id', '=', binding.source_file_id)
            .where('eligible', '=', 1)
            .where('expires_at', '>', at.toISOString())
            .executeTakeFirst()
          const current = await tx
            .selectFrom('scope_current_members')
            .select('version_id')
            .where('grant_id', '=', grant.id)
            .where('file_id', '=', binding.source_file_id)
            .executeTakeFirst()
          const previous = trash?.last_version_id ?? current?.version_id
          if (!previous) continue
          versionId = previous
        }
        const approval = readAudienceApproval(binding.approved_rebind_id)
        if (
          binding.approved_rebind_id !== null &&
          (!approval || approval.grantId !== grant.id || approval.originId !== binding.origin_id)
        )
          continue
        const tokenKey = approval?.tokenKey ?? binding.token_key
        const state = await memoryFor(binding.source_file_id, versionId),
          edge = state?.memory[tokenKey]
        if (!edge || !state!.active.includes(tokenKey)) continue
        const approved = approval
          ? await tx
              .selectFrom('scope_group_origins')
              .select('id')
              .where('id', '=', binding.origin_id)
              .where('vault_id', '=', vaultId)
              .where('source_file_id', '=', binding.source_file_id)
              .where('origin_kind', '=', 'owner_personal')
              .where('writer_account_id', '=', grant.owner_account_id)
              .where('target_file_id', '=', anchor)
              .executeTakeFirst()
          : undefined
        if (!approved && edge.targetId !== anchor) continue
        if (
          !approved &&
          edge.origin.kind !== 'owner_personal' &&
          !(edge.origin.kind === 'grant_native' && edge.origin.grantId === grant.id)
        )
          continue
        members.add(binding.source_file_id)
        if (members.size > 100000) throw unavailable()
        if (
          anchors.has(binding.source_file_id) &&
          source!.version.op !== 'delete' &&
          !seen.has(binding.source_file_id)
        )
          queue.push(binding.source_file_id)
      }
    }
    const current = await tx
      .selectFrom('scope_current_members')
      .select(['file_id', 'version_id'])
      .where('grant_id', '=', grant.id)
      .limit(100001)
      .execute()
    if (current.length > 100000) throw unavailable()
    const ids = new Set([...members, ...current.map((row) => row.file_id)])
    // Sponsored extras are projection dependencies, not body-link discoveries.
    const extras = await tx
      .selectFrom('scope_extra_entries')
      .select('file_id')
      .where('grant_id', '=', grant.id)
      .where('withdrawn_at', 'is', null)
      .limit(1001)
      .execute()
    if (extras.length > 1000) throw unavailable()
    for (const extra of extras) ids.add(extra.file_id)
    // First settle intrinsic notes/departures, so sponsorship cascades precede extras.
    const ordered = [...ids].sort((a, b) => Number(members.has(b)) - Number(members.has(a)))
    for (const id of ordered) {
      const source = await versionAt(id)
      if (!source) {
        if (current.some((row) => row.file_id === id)) throw unavailable()
        continue
      }
      let eligible = members.has(id),
        intrinsic = eligible
      if (
        !eligible &&
        extras.some((extra) => extra.file_id === id) &&
        scopedSecurityEligibility(source.file, options).eligible
      ) {
        const sponsors = await tx
          .selectFrom('scope_extra_sponsors')
          .select('note_id')
          .where('grant_id', '=', grant.id)
          .where(
            'entry_id',
            'in',
            tx
              .selectFrom('scope_extra_entries')
              .select('id')
              .where('grant_id', '=', grant.id)
              .where('file_id', '=', id)
              .where('withdrawn_at', 'is', null)
          )
          .limit(65)
          .execute()
        eligible = sponsors.length <= 64 && sponsors.some((sponsor) => members.has(sponsor.note_id))
      }
      await applyFolderAdmission(
        tx,
        { id: grant.id, folder_prefix: null },
        {
          ...source.file,
          versionId: source.version.id,
          sha: source.version.blob_sha,
          size: source.version.size,
          mtime: source.version.mtime,
          deleted: source.version.op === 'delete',
        },
        at,
        options,
        { eligible, intrinsic }
      )
    }
    const trash = await tx
      .selectFrom('scope_trash')
      .select(['file_id', 'interval_id'])
      .where('grant_id', '=', grant.id)
      .where('eligible', '=', 1)
      .limit(100001)
      .execute()
    if (trash.length > 100000) throw unavailable()
    for (const item of trash)
      if (!members.has(item.file_id) && !extras.some((extra) => extra.file_id === item.file_id))
        await tx
          .updateTable('scope_trash')
          .set({ eligible: 0 })
          .where('grant_id', '=', grant.id)
          .where('file_id', '=', item.file_id)
          .where('interval_id', '=', item.interval_id)
          .execute()
  }
}
