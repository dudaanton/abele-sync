import { AbeleError } from '@abele/sync-protocol'
import { z } from 'zod'
import { withVaultLock } from '../../oplog/lock.js'
import { authNow } from '../../auth/accounts.js'
import { publishGroupViews } from './views.js'
import { groupUnavailable, processGroupVersion, type GroupFactDeps } from './versionFacts.js'
export type GroupWorkerDeps = GroupFactDeps
const lineageSchema = z.object({
  version: z.object({ id: z.string(), fileId: z.string() }),
  sourceIds: z.array(z.string()).max(8),
  complete: z.boolean(),
})
function readLineage(body: string) {
  let decoded: unknown
  try {
    decoded = JSON.parse(body)
  } catch {
    throw groupUnavailable()
  }
  const parsed = lineageSchema.safeParse(decoded)
  if (!parsed.success) throw groupUnavailable()
  return parsed.data
}
/** One ordered bounded page outside the personal commit, including after a
 * frozen baseline. Unknown file facts do not fabricate active group edges.
 */
export async function processGroupDirtyPage(deps: GroupWorkerDeps, vaultId: string, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new AbeleError('invalid_request', 'group page limit exceeded')
  let certificate: { generation: number; processed_seq: number } | undefined
  try {
    return await withVaultLock(deps.db, deps.dialect, vaultId, async (tx) => {
      const at = authNow(deps).toISOString()
      const live = await tx
        .selectFrom('scope_grants')
        .select('id')
        .where('vault_id', '=', vaultId)
        .where('selector_kind', '=', 'group')
        .where('state', 'in', ['preparing', 'active'])
        .where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at)]))
        .limit(1)
        .executeTakeFirst()
      if (!live) return { processed: 0, ready: false }
      const progress = await tx
        .selectFrom('scope_group_progress')
        .selectAll()
        .where('vault_id', '=', vaultId)
        .executeTakeFirst()
      certificate = progress
      if (!progress || progress.status === 'unavailable') throw groupUnavailable()
      if (
        (progress.bootstrap_cursor !== null && progress.bootstrap_cursor !== 'complete') ||
        (progress.bootstrap_start_seq !== 0 && progress.bootstrap_cursor !== 'complete')
      )
        return { processed: 0, ready: false }
      const head = await tx
        .selectFrom('vault_seq')
        .select('head_seq')
        .where('vault_id', '=', vaultId)
        .executeTakeFirstOrThrow()
      const rows = await tx
        .selectFrom('scope_group_dirty')
        .selectAll()
        .where('vault_id', '=', vaultId)
        .where('committed_seq', '>', progress.processed_seq)
        .orderBy('committed_seq')
        .orderBy('ordinal')
        .limit(limit)
        .execute()
      if (rows.length !== Math.min(limit, head.head_seq - progress.processed_seq))
        throw groupUnavailable()
      let position = progress.processed_seq
      for (const row of rows) {
        if (row.committed_seq !== position + 1 || row.ordinal !== 0 || row.lineage.length > 65536)
          throw groupUnavailable()
        const lineage = readLineage(row.lineage)
        if (lineage.version.id !== row.version_id || lineage.version.fileId !== row.file_id)
          throw groupUnavailable()
        const version = await tx
          .selectFrom('versions')
          .select('seq')
          .where('vault_id', '=', vaultId)
          .where('file_id', '=', row.file_id)
          .where('id', '=', row.version_id)
          .executeTakeFirst()
        if (!version || version.seq !== row.committed_seq) throw groupUnavailable()
        await processGroupVersion(
          tx,
          deps,
          vaultId,
          row.file_id,
          row.version_id,
          at,
          lineage.complete
        )
        position = row.committed_seq
        await publishGroupViews(tx, vaultId, position, authNow(deps), {
          configurationDirectories:
            deps.configurationDirectories ?? deps.config?.configurationDirectories,
        })
      }
      const ready =
        position === head.head_seq &&
        (progress.bootstrap_start_seq === 0 || progress.bootstrap_cursor === 'complete')
      if (ready) {
        await publishGroupViews(tx, vaultId, position, authNow(deps), {
          configurationDirectories:
            deps.configurationDirectories ?? deps.config?.configurationDirectories,
        })
        await tx
          .updateTable('scope_grants')
          .set({ state: 'active' })
          .where('vault_id', '=', vaultId)
          .where('selector_kind', '=', 'group')
          .where('revoked_at', 'is', null)
          .execute()
      }
      await tx
        .updateTable('scope_group_progress')
        .set({ processed_seq: position, status: ready ? 'ready' : 'preparing', updated_at: at })
        .where('vault_id', '=', vaultId)
        .execute()
      return { processed: rows.length, ready }
    })
  } catch (error) {
    if (error instanceof AbeleError && error.code === 'invalid_request') throw error
    // Only explicit evidence failures justify stopping collection. Lock/storage
    // errors and unexpected exceptions roll back this page, but must not turn
    // subsequent personal commits into permanent holes in the evidence queue.
    if (!(error instanceof AbeleError && error.code === 'scope_unavailable')) {
      const failure = new AbeleError(
        'scope_unavailable',
        'group preparation interrupted; retry preparation',
        {
          retryable: true,
        }
      )
      failure.cause = error
      throw failure
    }
    if (certificate) {
      const failed = certificate
      await withVaultLock(deps.db, deps.dialect, vaultId, (tx) =>
        tx
          .updateTable('scope_group_progress')
          .set({ status: 'unavailable', updated_at: authNow(deps).toISOString() })
          .where('vault_id', '=', vaultId)
          // A new baseline or successful retry may have won the lock meanwhile.
          .where('generation', '=', failed.generation)
          .where('processed_seq', '=', failed.processed_seq)
          .execute()
      )
    }
    throw error
  }
}
