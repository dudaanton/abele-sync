import { AbeleError } from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { reconcileFolderFile } from './admissions.js'
import { managementAudit } from '../auth/folderManagementShared.js'
import { withOwnerManagement, type OwnerManagementDeps } from '../auth/freshOwner.js'
import {
  inheritedNamespaces,
  namespaceIsRestricted,
  reduceSecurity,
  sourceNamespaces,
  type SecurityFacts,
  type SecurityOptions,
} from './folderSecurity.js'

export const MAX_SECURITY_REPROOF_NODES = 128
const unknown = (): SecurityFacts => ({ executable: null, settings: null })
function sourceIds(text: string): string[] | null {
  if (text.length > 8192) return null
  try {
    const ids: unknown = JSON.parse(text)
    return Array.isArray(ids) &&
      ids.length <= 8 &&
      ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)
      ? ids
      : null
  } catch {
    return null
  }
}
/** Explicit owner preparation, never an ordinary commit's global scan. Reproves only
 * bounded metadata lineage; it cannot guess pruned/missing restore/copy origins or
 * upgrade a legacy writer into owner-personal group authority. No payload parser.
 */
export async function reproveFileSecurity(
  deps: OwnerManagementDeps & SecurityOptions,
  token: string,
  vaultId: string,
  fileId: string
) {
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const file = await tx
      .selectFrom('files')
      .select('head_version_id')
      .where('vault_id', '=', vaultId)
      .where('id', '=', fileId)
      .executeTakeFirst()
    if (!file?.head_version_id) throw new AbeleError('not_found', 'no file security baseline')
    const done = new Map<string, SecurityFacts>(),
      visiting = new Set<string>()
    let examined = 0
    const prove = async (id: string): Promise<SecurityFacts> => {
      const ready = done.get(id)
      if (ready) return ready
      if (visiting.has(id) || examined >= MAX_SECURITY_REPROOF_NODES) return unknown()
      visiting.add(id)
      examined++
      const recorded = await tx
        .selectFrom('version_security_sources')
        .selectAll()
        .where('vault_id', '=', vaultId)
        .where('version_id', '=', id)
        .executeTakeFirst()
      const row = await tx
        .selectFrom('versions')
        .select(['id', 'file_id', 'path', 'no', 'op', 'prev_version_id', 'merge'])
        .where('vault_id', '=', vaultId)
        .where('id', '=', id)
        .executeTakeFirst()
      if (!row) {
        const roots = sourceNamespaces(recorded?.source_namespaces)
        const facts: SecurityFacts = recorded
          ? {
              executable: recorded.executable,
              settings:
                roots !== null && namespaceIsRestricted(roots, deps)
                  ? 1
                  : roots === null && recorded.settings !== 1
                    ? null
                    : recorded.settings,
              source_namespaces: recorded.source_namespaces,
            }
          : unknown()
        visiting.delete(id)
        done.set(id, facts)
        return facts
      }
      const refs = recorded ? sourceIds(recorded.source_version_ids) : null
      const retained = recorded
        ? {
            executable: recorded.executable,
            settings: recorded.settings,
            source_namespaces: recorded.source_namespaces,
          }
        : null
      let ids: string[] = [],
        incomplete = false
      const original =
        row.op === 'create' && row.no === 1 && row.prev_version_id === null && row.merge === null
      // A legacy repair row may contain only a partial set from an earlier attempt.
      // Validate retained merge metadata even when those IDs now exist; they cannot
      // replace missing head/base evidence or make incomplete lineage complete.
      let mergeIds: string[] | null = null
      if (row.op === 'merge') {
        try {
          if (!row.merge || row.merge.length > 8192) throw new Error('missing merge lineage')
          const merge = JSON.parse(row.merge) as {
            head_version_id?: unknown
            base_version_id?: unknown
          }
          const validId = (value: unknown): value is string =>
            typeof value === 'string' && value.length > 0 && value.length <= 200
          if (
            !validId(merge.head_version_id) ||
            (merge.base_version_id !== null && !validId(merge.base_version_id))
          )
            throw new Error('incomplete merge lineage')
          mergeIds = [
            merge.head_version_id,
            ...(merge.base_version_id === null ? [] : [merge.base_version_id]),
          ]
        } catch {
          incomplete = true
        }
      }
      if (!original) {
        if (refs?.length) ids = [...refs]
        else if (row.op === 'restore' || row.op === 'conflict') {
          // Old schemas retained only the preceding head, not the actual restored/copy source.
          incomplete = true
          if (row.prev_version_id) ids.push(row.prev_version_id)
        } else {
          if (row.prev_version_id) ids.push(row.prev_version_id)
          else incomplete = true
        }
        if (mergeIds) ids.push(...mergeIds)
      }
      ids = [...new Set(ids)]
      if (ids.length > 8 || ids.some((source) => source.length > 200)) {
        ids = []
        incomplete = true
      }
      const sources: (SecurityFacts | null)[] = []
      // Complete compact facts survive payload GC. Positive restrictions always survive repair.
      const completeRecorded =
        !incomplete &&
        refs !== null &&
        sourceNamespaces(retained?.source_namespaces) !== null &&
        retained?.executable !== null &&
        retained?.settings !== null &&
        retained !== null
      if (completeRecorded) sources.push(retained)
      else {
        for (const source of ids) sources.push(await prove(source))
        if (incomplete) sources.push(null)
      }
      const derived = reduceSecurity(row.path, 'attachment', sources, original, deps)
      const roots = inheritedNamespaces(
        row.path,
        sources.map((source) => sourceNamespaces(source?.source_namespaces))
      )
      const facts: SecurityFacts = {
        executable: retained?.executable === 1 ? 1 : derived.executable,
        settings:
          retained?.settings === 1 || (roots !== null && namespaceIsRestricted(roots, deps))
            ? 1
            : roots === null
              ? null
              : derived.settings,
        source_namespaces: roots === null ? null : JSON.stringify(roots),
      }
      if (recorded) {
        await tx
          .updateTable('version_security_sources')
          .set({
            executable: facts.executable,
            settings: facts.settings,
            source_namespaces: facts.source_namespaces ?? null,
            ...(incomplete ? { source_version_ids: '[]' } : {}),
          })
          .where('version_id', '=', id)
          .where('vault_id', '=', vaultId)
          .execute()
      } else {
        await tx
          .insertInto('version_security_sources')
          .values({
            version_id: id,
            vault_id: vaultId,
            file_id: row.file_id,
            writer_facet: 'unknown',
            writer_principal_id: null,
            writer_account_id: null,
            writer_grant_id: null,
            executable: facts.executable,
            settings: facts.settings,
            source_namespaces: facts.source_namespaces ?? null,
            // Partial IDs are not an explicit complete source set for any operation.
            source_version_ids: JSON.stringify(incomplete ? [] : ids),
            recorded_at: authNow(deps).toISOString(),
          })
          .execute()
      }
      visiting.delete(id)
      done.set(id, facts)
      return facts
    }
    const security = await prove(file.head_version_id)
    await reconcileFolderFile(tx, vaultId, fileId, authNow(deps), deps)
    await managementAudit(
      tx,
      session.accountId,
      vaultId,
      'scope.security.reprove',
      fileId,
      authNow(deps)
    )
    return {
      version_id: file.head_version_id,
      state:
        security.executable === null || security.settings === null
          ? ('hold' as const)
          : ('known' as const),
      security,
      examined,
    }
  })
}
