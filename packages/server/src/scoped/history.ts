import { AbeleError } from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { withScopedAuthority } from './authority.js'
import { folderVersionInTransaction } from './admissions.js'
import { renderScopedContent, type ScopedContentRequest } from './content.js'
import type { SnapshotDeps } from './snapshots.js'

const missing = () => new AbeleError('not_found', 'no admitted version')
const bound = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new AbeleError('invalid_request', 'history page limit exceeded')
}
const label = (deps: SnapshotDeps) =>
  `v4-folder-history:${deps.endpointIdentity ?? deps.config?.publicUrl ?? 'local'}`
function cursor(
  deps: SnapshotDeps,
  data: {
    kind: 'history' | 'trash'
    file_id: string
    before: string
    principal: string
    grant: string
    vault: string
    digest: string
  }
) {
  return deps.store.sealPart(Buffer.from(JSON.stringify(data)), label(deps)).toString('base64url')
}
function parseCursor(
  deps: SnapshotDeps,
  input: string | undefined,
  a: {
    principal: { principal_id: string; grant_id: string; vault_id: string }
    continuityDigest: string
  },
  kind: 'history' | 'trash',
  fileId: string
) {
  if (input === undefined) return undefined
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(input)) throw missing()
  try {
    const bytes = Buffer.from(input, 'base64url')
    if (bytes.toString('base64url') !== input) throw missing()
    const opened = deps.store.openPart(bytes, label(deps))
    if (!opened || opened.length > 1000) throw missing()
    const value = JSON.parse(opened.toString('utf8')) as Record<string, unknown>
    if (
      value.kind !== kind ||
      value.file_id !== fileId ||
      value.principal !== a.principal.principal_id ||
      value.grant !== a.principal.grant_id ||
      value.vault !== a.principal.vault_id ||
      value.digest !== a.continuityDigest ||
      typeof value.before !== 'string' ||
      value.before.length > 200
    )
      throw missing()
    return value.before
  } catch {
    throw missing()
  }
}
export async function listFolderHistory(
  deps: SnapshotDeps,
  token: string,
  vaultId: string,
  grantId: string,
  fileId: string,
  limit = 100,
  cursorToken?: string
) {
  bound(limit)
  return withScopedAuthority(deps, token, vaultId, grantId, 'read', async (tx, a) => {
    const before = parseCursor(deps, cursorToken, a, 'history', fileId)
    const current = await tx
      .selectFrom('scope_current_members')
      .select('interval_id')
      .where('grant_id', '=', grantId)
      .where('vault_id', '=', vaultId)
      .where('file_id', '=', fileId)
      .executeTakeFirst()
    const trash = current
      ? undefined
      : await tx
          .selectFrom('scope_trash')
          .select('interval_id')
          .where('grant_id', '=', grantId)
          .where('file_id', '=', fileId)
          .where('eligible', '=', 1)
          .where('expires_at', '>', authNow(deps).toISOString())
          .executeTakeFirst()
    const interval = current?.interval_id ?? trash?.interval_id
    if (!interval) throw missing()
    let query = tx
      .selectFrom('scope_version_admissions as admitted')
      .innerJoin('versions as version', 'version.id', 'admitted.version_id')
      .select([
        'version.id',
        'version.no',
        'version.op',
        'version.path',
        'version.blob_sha',
        'version.size',
        'version.mtime',
      ])
      .where('admitted.grant_id', '=', grantId)
      .where('admitted.vault_id', '=', vaultId)
      .where('admitted.file_id', '=', fileId)
      .where('admitted.interval_id', '=', interval)
      .where('version.vault_id', '=', vaultId)
      .where('version.file_id', '=', fileId)
      .orderBy('version.no', 'desc')
      .limit(limit + 1)
    if (before !== undefined) {
      const boundary = await tx
        .selectFrom('versions')
        .select('no')
        .where('id', '=', before)
        .where('file_id', '=', fileId)
        .where('vault_id', '=', vaultId)
        .executeTakeFirst()
      if (!boundary) throw missing()
      query = query.where('version.no', '<', boundary.no)
    }
    const rows = await query.execute(),
      items = []
    for (const row of rows.slice(0, limit)) {
      try {
        await folderVersionInTransaction(tx, a, fileId, row.id, authNow(deps), deps)
      } catch (error) {
        if (error instanceof AbeleError && error.code === 'not_found') continue
        throw error
      }
      // Do not serialize original actor, private merge inputs, vault-global seq or former paths.
      items.push({
        version_id: row.id,
        op: row.op,
        path: row.path,
        sha: row.blob_sha,
        size: row.size,
        mtime: row.mtime,
      })
    }
    const last = rows.slice(0, limit).at(-1)
    return {
      items,
      next_cursor:
        rows.length > limit && last
          ? cursor(deps, {
              kind: 'history',
              file_id: fileId,
              before: last.id,
              principal: a.principal.principal_id,
              grant: grantId,
              vault: vaultId,
              digest: a.continuityDigest,
            })
          : null,
    }
  })
}
export async function listFolderTrash(
  deps: SnapshotDeps,
  token: string,
  vaultId: string,
  grantId: string,
  limit = 100,
  cursorToken?: string
) {
  bound(limit)
  return withScopedAuthority(deps, token, vaultId, grantId, 'read', async (tx, a) => {
    const before = parseCursor(deps, cursorToken, a, 'trash', 'trash')
    let query = tx
      .selectFrom('scope_trash')
      .select(['file_id', 'last_version_id', 'deleted_at', 'interval_id'])
      .where('grant_id', '=', grantId)
      .where('vault_id', '=', vaultId)
      .where('eligible', '=', 1)
      .where('expires_at', '>', authNow(deps).toISOString())
      .orderBy('file_id')
      .limit(limit + 1)
    if (before !== undefined) query = query.where('file_id', '>', before)
    const rows = await query.execute(),
      items = []
    for (const row of rows.slice(0, limit)) {
      try {
        await folderVersionInTransaction(
          tx,
          a,
          row.file_id,
          row.last_version_id,
          authNow(deps),
          deps
        )
      } catch (error) {
        if (error instanceof AbeleError && error.code === 'not_found') continue
        throw error
      }
      items.push({
        file_id: row.file_id,
        last_version_id: row.last_version_id,
        deleted_at: row.deleted_at,
      })
    }
    const last = rows.slice(0, limit).at(-1)
    return {
      items,
      next_cursor:
        rows.length > limit && last
          ? cursor(deps, {
              kind: 'trash',
              file_id: 'trash',
              before: last.file_id,
              principal: a.principal.principal_id,
              grant: grantId,
              vault: vaultId,
              digest: a.continuityDigest,
            })
          : null,
    }
  })
}
export async function readFolderHistoricalVersion(
  deps: SnapshotDeps,
  token: string,
  vaultId: string,
  grantId: string,
  fileId: string,
  versionId: string,
  request: ScopedContentRequest
) {
  return withScopedAuthority(deps, token, vaultId, grantId, 'read', async (tx, a) => {
    await folderVersionInTransaction(tx, a, fileId, versionId, authNow(deps), deps)
    const row = await tx
      .selectFrom('versions')
      .select(['blob_sha', 'size'])
      .where('id', '=', versionId)
      .where('file_id', '=', fileId)
      .where('vault_id', '=', vaultId)
      .executeTakeFirst()
    if (!row?.blob_sha) throw missing()
    if (row.size > 200 * 1024 * 1024)
      throw new AbeleError('too_large', 'history byte response bound reached')
    let bytes: Buffer
    try {
      bytes = await deps.store.get(row.blob_sha)
    } catch {
      throw missing()
    }
    if (bytes.length !== row.size) throw missing()
    return renderScopedContent(row.blob_sha, bytes, request)
  })
}
