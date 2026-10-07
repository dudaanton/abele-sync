import { z } from 'zod'
import { AbeleError } from '@abele/sync-protocol'
import { sql } from 'kysely'
import { withOwnerManagement } from './freshOwner.js'
import { authenticateDevice } from './devices.js'
import { groupGrantRow } from './groupManagement.js'
import { authNow } from './accounts.js'
import { request, managementAudit, type FolderManagementDeps } from './folderManagementShared.js'
import { versionFolderFile } from '../scoped/admissionPolicy.js'
import { scopedSecurityEligibility } from '../scoped/folderSecurity.js'
import { publishGroupViews } from '../scoped/groups/views.js'
import { newId } from '../ids.js'
import { audienceApproval, approvalBindingKey } from '../scoped/groups/audienceApproval.js'
const id = z.string().min(1).max(200)
/** Fresh owner + an actual owner-personal device, exact source/target preview.
 * Approval is standalone audited evidence; it never rewrites parse provenance.
 */
export function approveGroupRelation(
  deps: FolderManagementDeps,
  ownerToken: string,
  vaultId: string,
  grantId: string,
  input: unknown
) {
  const body = request(
    z
      .object({
        device_token: z.string(),
        expected_revision: z.number().int().nonnegative(),
        source_file_id: id,
        source_version_id: id,
        target_file_id: id,
        target_version_id: id,
        token_key: z.string().min(1).max(1024),
        anchor: z.boolean().default(false),
      })
      .strict(),
    input
  )
  return withOwnerManagement(deps, ownerToken, vaultId, async (tx, session) => {
    const at = authNow(deps),
      grant = await groupGrantRow(tx, vaultId, grantId, deps.dialect, true, at)
    if (grant.acl_revision !== body.expected_revision)
      throw new AbeleError('conflict', 'approval preview changed')
    if (
      body.target_file_id !== grant.root_file_id &&
      !(await tx
        .selectFrom('scope_group_anchors')
        .select('file_id')
        .where('grant_id', '=', grantId)
        .where('vault_id', '=', vaultId)
        .where('file_id', '=', body.target_file_id)
        .executeTakeFirst())
    )
      throw new AbeleError('forbidden', 'the target is not an approved anchor of this audience')
    const bound = { ...deps, db: tx },
      device = await authenticateDevice(bound, body.device_token)
    if (device.accountId !== session.accountId || device.vaultId !== vaultId)
      throw new AbeleError('forbidden', 'an owner-personal device is required')
    const progress = await tx
      .selectFrom('scope_group_progress')
      .innerJoin('vault_seq', 'vault_seq.vault_id', 'scope_group_progress.vault_id')
      .select(['processed_seq', 'head_seq', 'status'])
      .where('scope_group_progress.vault_id', '=', vaultId)
      .executeTakeFirst()
    if (!progress || progress.status !== 'ready' || progress.processed_seq !== progress.head_seq)
      throw new AbeleError('scope_updating', 'approval requires a certified preview')
    for (const [fileId, versionId] of [
      [body.source_file_id, body.source_version_id],
      [body.target_file_id, body.target_version_id],
    ]) {
      const file = await tx
        .selectFrom('files')
        .select(['head_version_id', 'deleted_at'])
        .where('vault_id', '=', vaultId)
        .where('id', '=', fileId!)
        .executeTakeFirst()
      const source = file ? await versionFolderFile(tx, vaultId, fileId!, versionId!) : null
      if (
        !file ||
        file.deleted_at !== null ||
        file.head_version_id !== versionId ||
        !source ||
        source.file.kind !== 'note' ||
        !scopedSecurityEligibility(source.file, {
          configurationDirectories: deps.configurationDirectories,
        }).eligible
      )
        throw new AbeleError('conflict', 'approval file preview changed')
    }
    const fact = await tx
      .selectFrom('scope_group_parse_facts')
      .select('facts')
      .where('vault_id', '=', vaultId)
      .where('file_id', '=', body.source_file_id)
      .where('version_id', '=', body.source_version_id)
      .executeTakeFirst()
    if (!fact || fact.facts.length > 1024 * 1024)
      throw new AbeleError('scope_unavailable', 'source token proof unavailable')
    const state = JSON.parse(fact.facts) as { active: string[] }
    if (!state.active.includes(body.token_key))
      throw new AbeleError('conflict', 'source token preview changed')
    const originId = newId()
    await tx
      .insertInto('scope_group_origins')
      .values({
        id: originId,
        vault_id: vaultId,
        source_file_id: body.source_file_id,
        token_key: body.token_key,
        introduced_version_id: body.source_version_id,
        introduced_at: at.toISOString(),
        origin_kind: 'owner_personal',
        writer_facet: 'device',
        writer_principal_id: device.deviceId,
        writer_account_id: session.accountId,
        origin_grant_id: null,
        target_file_id: body.target_file_id,
      })
      .execute()
    const approval = {
      origin_id: originId,
      target_file_id: body.target_file_id,
      state: 'bound' as const,
      approved_rebind_id: audienceApproval(grantId, body.token_key, originId),
    }
    await tx
      .insertInto('scope_group_bindings')
      .values({
        vault_id: vaultId,
        source_file_id: body.source_file_id,
        token_key: approvalBindingKey(grantId, body.token_key),
        ...approval,
      })
      .onConflict((oc) =>
        oc.columns(['vault_id', 'source_file_id', 'token_key']).doUpdateSet(approval)
      )
      .execute()
    if (body.anchor)
      await tx
        .insertInto('scope_group_anchors')
        .values({
          grant_id: grantId,
          vault_id: vaultId,
          file_id: body.source_file_id,
          owner_account_id: session.accountId,
          approved_device_id: device.deviceId,
          approved_at: at.toISOString(),
          approval_version_id: body.source_version_id,
        })
        .onConflict((oc) =>
          oc.columns(['grant_id', 'file_id']).doUpdateSet({
            approved_device_id: device.deviceId,
            approved_at: at.toISOString(),
            approval_version_id: body.source_version_id,
          })
        )
        .execute()
    await tx
      .updateTable('scope_grants')
      .set({ acl_revision: sql<number>`acl_revision + 1` })
      .where('id', '=', grantId)
      .execute()
    await managementAudit(tx, session.accountId, vaultId, 'scope.group.approve', originId, at)
    await publishGroupViews(tx, vaultId, progress.head_seq, at, {
      configurationDirectories: deps.configurationDirectories,
    })
    await authenticateDevice(bound, body.device_token)
    return { approval_id: originId }
  })
}
