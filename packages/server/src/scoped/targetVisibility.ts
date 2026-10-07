import { AbeleError, TargetVisibilitySchema } from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { withOwnerDevice, publicationGeneration, type AssetDeps } from './assetAuthority.js'
import { folderVersionInTransaction } from './admissions.js'

/** Owner point read, not an inventory or a publication decision. Delivery rechecks
 * the same interval/security predicate; every subsequent write keeps its own CAS.
 */
export async function readTargetVisibility(
  deps: AssetDeps,
  token: string,
  vault: string,
  grant: string,
  fileId: string
) {
  return withOwnerDevice(deps, token, vault, grant, async (tx, _device, row) => {
    if (
      row.state === 'unavailable' ||
      (row.selector_kind === 'folder' ? row.folder_prefix === null : row.root_file_id === null)
    )
      throw new AbeleError('scope_unavailable', 'scope selector is unavailable')
    if (row.state !== 'active') throw new AbeleError('scope_updating', 'grant view is preparing')
    if (row.selector_kind === 'group') {
      const root = await tx
        .selectFrom('files')
        .select('id')
        .where('vault_id', '=', vault)
        .where('id', '=', row.root_file_id!)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()
      if (!root) throw new AbeleError('scope_unavailable', 'group root is unavailable')
    }
    if (!fileId || fileId.length > 200) throw new AbeleError('not_found', 'no target')
    const file = await tx
      .selectFrom('files')
      .select(['head_version_id', 'deleted_at'])
      .where('vault_id', '=', vault)
      .where('id', '=', fileId)
      .executeTakeFirst()
    if (!file) throw new AbeleError('not_found', 'no target')
    const member = await tx
      .selectFrom('scope_current_members')
      .select(['version_id', 'sha'])
      .where('vault_id', '=', vault)
      .where('grant_id', '=', grant)
      .where('file_id', '=', fileId)
      .executeTakeFirst()
    let targetVersionId: string | null = null
    if (file.deleted_at === null && member?.sha && member.version_id === file.head_version_id) {
      try {
        await folderVersionInTransaction(
          tx,
          {
            principal: { vault_id: vault, grant_id: grant },
            prefix: row.folder_prefix ?? '',
            selector:
              row.selector_kind === 'folder'
                ? { kind: 'folder', prefix: row.folder_prefix! }
                : { kind: 'group', root_file_id: row.root_file_id! },
          },
          fileId,
          member.version_id,
          authNow(deps),
          deps
        )
        targetVersionId = member.version_id
      } catch (error) {
        if (!(error instanceof AbeleError && error.code === 'not_found')) throw error
      }
    }
    return TargetVisibilitySchema.parse({
      grantId: grant,
      label: row.label,
      targetFileId: fileId,
      visible: targetVersionId !== null,
      targetVersionId,
      scopeRevision: row.scope_revision,
      revision: row.publication_revision,
      withdrawalGeneration: await publicationGeneration(tx, grant),
    })
  })
}
