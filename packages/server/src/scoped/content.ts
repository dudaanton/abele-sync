import { AbeleError, ShaSchema } from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { withScopedAuthority } from './authority.js'
import { folderVersionInTransaction } from './admissions.js'
import type { SnapshotDeps } from './snapshots.js'

export type ScopedCurrentTarget =
  { file_id: string; sha?: never } | { sha: string; file_id?: never }
export interface ScopedContentRequest {
  method: 'GET' | 'HEAD'
  range?: string
  ifNoneMatch?: string
  ifRange?: string
}
export interface ScopedContentResponse {
  status: 200 | 206 | 304 | 416
  headers: Record<string, string>
  body?: Buffer
}
const missing = () => new AbeleError('not_found', 'no authorized content')
/** Single byte ranges only. Unsupported syntax is ignored; unsatisfiable/multiple ranges
 * return 416 only after authorization, never as a private-existence oracle.
 */
function range(
  header: string | undefined,
  total: number
): { start: number; end: number } | null | 'bad' {
  if (!header || !header.trim().toLowerCase().startsWith('bytes=')) return null
  const value = header.trim().slice(6).trim()
  if (value.includes(',')) return 'bad'
  const parsed = /^(\d*)-(\d*)$/.exec(value)
  if (!parsed || (!parsed[1] && !parsed[2])) return null
  if (!total) return 'bad'
  if (!parsed[1]) {
    const count = Number(parsed[2])
    if (!Number.isSafeInteger(count) || count <= 0) return 'bad'
    return { start: Math.max(0, total - count), end: total - 1 }
  }
  const start = Number(parsed[1]),
    end = parsed[2] ? Math.min(Number(parsed[2]), total - 1) : total - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= total || start > end)
    return 'bad'
  return { start, end }
}
/** All current-content surfaces authorize first, including HEAD/304 and hash lookup. Upload
 * entitlement alone is not read authority. No private former path/actor/usage is serialized.
 */
export async function readScopedCurrent(
  deps: SnapshotDeps,
  token: string,
  vaultId: string,
  grantId: string,
  target: ScopedCurrentTarget,
  request: ScopedContentRequest
): Promise<ScopedContentResponse> {
  return withScopedAuthority(deps, token, vaultId, grantId, 'read', async (tx, a) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      throw new AbeleError('invalid_request', 'unsupported content method')
    if (
      ('sha' in target && !ShaSchema.safeParse(target.sha).success) ||
      ('file_id' in target && (typeof target.file_id !== 'string' || !target.file_id))
    )
      throw missing()
    let query = tx
      .selectFrom('scope_current_members')
      .selectAll()
      .where('grant_id', '=', grantId)
      .where('vault_id', '=', vaultId)
    query =
      'file_id' in target
        ? query.where('file_id', '=', target.file_id!)
        : query.where('sha', '=', target.sha)
    let current: Awaited<ReturnType<typeof query.execute>>[number] | undefined,
      after: string | undefined,
      scanned = 0
    while (!current && scanned < 100000) {
      const page = await (after === undefined ? query : query.where('file_id', '>', after))
        .orderBy('file_id')
        .limit(64)
        .execute()
      for (const candidate of page) {
        scanned++
        try {
          await folderVersionInTransaction(
            tx,
            a,
            candidate.file_id,
            candidate.version_id,
            authNow(deps),
            deps
          )
          current = candidate
          break
        } catch (error) {
          if (!(error instanceof AbeleError && error.code === 'not_found')) throw error
        }
      }
      if (page.length < 64) break
      after = page.at(-1)?.file_id
    }
    // Exhausted unauthorized/absent candidates and bounded lookup both have the
    // same generic miss. Counting forbidden identities is never an existence oracle.
    if (!current || !current.sha) throw missing()
    const version = await tx
      .selectFrom('versions')
      .select(['blob_sha', 'size'])
      .where('vault_id', '=', vaultId)
      .where('file_id', '=', current.file_id)
      .where('id', '=', current.version_id)
      .executeTakeFirst()
    if (!version || version.blob_sha !== current.sha || version.size !== current.size)
      throw missing()
    // Match the personal server's initial file ceiling. Oversized/corrupt metadata
    // cannot cause an unbounded allocation; streaming delivery is a separate adapter.
    if (current.size > 200 * 1024 * 1024)
      throw new AbeleError('too_large', 'content response bound reached')
    // Integrity/presence precedes conditionals: a lost blob never yields a false 304.
    let bytes: Buffer
    try {
      bytes = await deps.store.get(current.sha)
    } catch {
      throw missing()
    }
    if (bytes.length !== current.size) throw missing()
    return renderScopedContent(current.sha, bytes, request)
  })
}
/** Shared byte serializer: authorization and integrity precede this for every route. */
export function renderScopedContent(
  sha: string,
  bytes: Buffer,
  request: ScopedContentRequest
): ScopedContentResponse {
  const etag = `"${sha}"`
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
    etag,
    'content-type': 'application/octet-stream',
  }
  const tags = request.ifNoneMatch?.split(',').map((tag) => tag.trim().replace(/^W\//, '')) ?? []
  if (tags.includes(etag) || tags.includes('*')) return { status: 304, headers }
  // A strong matching validator permits resume. Stale/weak/date validators must
  // fall back to the full representation, never splice an old prefix and new tail.
  const canRange = request.ifRange === undefined || request.ifRange.trim() === etag
  const selected = range(canRange ? request.range : undefined, bytes.length)
  if (selected === 'bad')
    return { status: 416, headers: { ...headers, 'content-range': `bytes */${bytes.length}` } }
  const body = selected === null ? bytes : bytes.subarray(selected.start, selected.end + 1)
  headers['content-length'] = String(body.length)
  if (selected !== null)
    headers['content-range'] = `bytes ${selected.start}-${selected.end}/${bytes.length}`
  return {
    status: selected === null ? 200 : 206,
    headers,
    ...(request.method === 'GET' ? { body } : {}),
  }
}
