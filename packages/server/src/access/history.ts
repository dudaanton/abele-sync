import { AbeleError, type CommitOpResult, type V2CommitOp } from '@abele/sync-protocol'
import { withToken } from './reads.js'
import { covers, historyAuthority, versionVisible } from './visibility.js'
import { type AccessDeps } from './tokens.js'
import { listVersions } from '../history/versions.js'
import { listTrash, lastWithContent } from '../history/trash.js'
import { commitWithToken } from './commit.js'
import type { CommitDeps } from '../oplog/commit.js'

export async function historyWithToken(
  deps: AccessDeps,
  key: string,
  fileId: string,
  opts: { limit: number; before?: number }
) {
  return withToken(deps, key, async (deps, p) => {
    await historyAuthority(deps, p, fileId)
    const rows = await listVersions(deps.db, p.space.id, fileId, { ...opts, scopeId: p.scope.id })
    // Merge ancestry may name private versions. Do not disclose it through partial authority.
    const root = await covers(deps, p.scope, '.obsidian/config.json')
    return rows.map((row) => ({ ...row, merge: root ? row.merge : null }))
  })
}
export async function trashWithToken(deps: AccessDeps, key: string, prefix?: string) {
  return withToken(deps, key, async (deps, p) => {
    const rows = await listTrash(deps.db, p.space.id, prefix)
    const result = []
    for (const row of rows) {
      try {
        await historyAuthority(deps, p, row.file_id)
      } catch (error) {
        if (error instanceof AbeleError && error.code === 'not_found') continue
        throw error
      }
      if (await versionVisible(deps.db, p.scope.id, row.file_id, row.last_version_id))
        result.push(row)
    }
    return result
  })
}
export async function restoreWithToken(
  deps: CommitDeps & AccessDeps,
  key: string,
  fileIds: string[],
  versionId: string | undefined,
  idempotencyKey: string
) {
  return commitWithToken(
    deps,
    key,
    [],
    idempotencyKey,
    async (db, p) => {
      const result: Array<V2CommitOp | CommitOpResult> = []
      for (const fileId of fileIds) {
        let wanted = versionId
        if (!wanted) {
          const version = await db
            .selectFrom('versions as v')
            .innerJoin('files as f', 'f.id', 'v.file_id')
            .select('v.id')
            .where('f.vault_id', '=', p.space.id)
            .where('f.id', '=', fileId)
            .where('f.deleted_at', 'is not', null)
            .where('v.blob_sha', 'is not', null)
            .where(lastWithContent())
            .executeTakeFirst()
          wanted = version?.id
        }
        result.push(
          wanted
            ? { op: 'restore', file_id: fileId, version_id: wanted }
            : { status: 'rejected', code: 'not_found', message: 'no file in this scope trash' }
        )
      }
      return result
    },
    { restore: fileIds, versionId: versionId ?? null }
  )
}
