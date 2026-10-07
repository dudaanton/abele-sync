import type { Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { newId } from '../../ids.js'
import type { GroupOriginState } from './origins.js'
/** Immutable source facts outlive retained payload. A copied token retains its
 * introducer, but receives a source-local row identity, never the output actor.
 */
export async function storeGroupOrigins(
  tx: Transaction<Database>,
  vaultId: string,
  fileId: string,
  state: GroupOriginState,
  at: string
): Promise<GroupOriginState> {
  const result = structuredClone(state)
  for (const [key, edge] of Object.entries(result.memory)) {
    const origin = edge.origin
    const existing = await tx
      .selectFrom('scope_group_origins')
      .select(['vault_id', 'source_file_id'])
      .where('id', '=', origin.id)
      .executeTakeFirst()
    if (existing?.vault_id === vaultId && existing.source_file_id === fileId) continue
    if (existing) origin.id = newId()
    await tx
      .insertInto('scope_group_origins')
      .values({
        id: origin.id,
        vault_id: vaultId,
        source_file_id: fileId,
        token_key: key,
        introduced_version_id: origin.versionId,
        introduced_at: at,
        origin_kind: origin.kind,
        writer_facet: origin.writer.facet,
        writer_principal_id: origin.writer.principalId,
        writer_account_id: origin.writer.accountId,
        origin_grant_id: origin.grantId,
        target_file_id: edge.targetId,
      })
      .execute()
  }
  return result
}
