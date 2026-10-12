import {
  AbeleError,
  EXTERNAL_FILES_MAX_BYTES,
  ExternalVerifyRequestSchema,
  ManifestItemSchema,
  VaultSettingsSchema,
  validatePath,
  type ExternalVerifyRequest,
  type ExternalVerifyResponse,
  type V2ExternalFilesCapabilities,
} from '@abele/sync-protocol'
import type { BlobStore } from '../blobs/store.js'
import { withToken } from './reads.js'
import { activeScope, covers, member, versionVisible } from './visibility.js'
import { authenticateToken, type AccessDeps, type TokenPrincipal } from './tokens.js'

interface ExternalDeps extends AccessDeps {
  store: BlobStore
  maxFileBytes: number
}
const missing = () => new AbeleError('not_found', 'no verifiable live file in this scope')
const ceiling = (deps: ExternalDeps, p: TokenPrincipal) =>
  Math.min(
    EXTERNAL_FILES_MAX_BYTES,
    deps.maxFileBytes,
    VaultSettingsSchema.parse(JSON.parse(p.space.settings)).max_file_bytes
  )

/** Read the actual live engine head, not a historical version or just the projection.
 * Both the derived member and recorded version-time visibility must authorize that head. */
async function liveHead(deps: AccessDeps, p: TokenPrincipal, fileId: string) {
  const visible = await member(deps.db, p.scope.id, fileId)
  if (!visible || visible.kind === 'directory') throw missing()
  const row = await deps.db
    .selectFrom('files as f')
    .innerJoin('versions as v', 'v.id', 'f.head_version_id')
    .select([
      'f.id as file_id',
      'f.path as path',
      'f.kind as kind',
      'v.id as version_id',
      'v.seq as seq',
      'v.blob_sha as sha',
      'v.size as size',
      'v.mtime as mtime',
      'v.path as version_path',
    ])
    .where('f.vault_id', '=', p.space.id)
    .where('f.id', '=', fileId)
    .where('f.deleted_at', 'is', null)
    .where('v.vault_id', '=', p.space.id)
    .where('v.file_id', '=', fileId)
    .where('v.op', '!=', 'delete')
    .executeTakeFirst()
  if (
    !row ||
    row.path !== row.version_path ||
    row.path !== visible.path ||
    row.version_id !== visible.version_id ||
    !(await covers(deps, p.scope, row.path, fileId)) ||
    !(await versionVisible(deps.db, p.scope.id, fileId, row.version_id))
  )
    throw missing()
  const parsed = ManifestItemSchema.safeParse(row)
  if (!parsed.success) throw missing()
  validatePath(parsed.data.path)
  return parsed.data
}
export async function externalCapabilitiesWithToken(
  deps: ExternalDeps,
  key: string
): Promise<V2ExternalFilesCapabilities> {
  return withToken(deps, key, async (_access, p) => ({
    extension_version: 1,
    projection_schema: 1,
    token: true,
    verification: {
      live_head: true,
      sha256: true,
      actual_size: true,
      authorization_rechecked: true,
    },
    max_file_size: ceiling(deps, p),
  }))
}
export async function headWithToken(deps: AccessDeps, key: string, fileId: string) {
  return withToken(deps, key, (deps, p) => liveHead(deps, p, fileId))
}
export async function verifyExternalWithToken(
  deps: ExternalDeps,
  key: string,
  fileId: string,
  input: ExternalVerifyRequest
): Promise<ExternalVerifyResponse> {
  const expected = ExternalVerifyRequestSchema.parse(input)
  validatePath(expected.path)
  return withToken(deps, key, async (access, p) => {
    if (expected.size > ceiling(deps, p))
      throw new AbeleError('too_large', 'external verification exceeds the file size ceiling')
    const head = await liveHead(access, p, fileId)
    if (
      head.version_id !== expected.version_id ||
      head.path !== expected.path ||
      head.sha !== expected.sha ||
      head.size !== expected.size
    )
      throw missing()
    // Retention's GC claims this same reference row before deleting bytes. Keep its
    // lock until verification and the final authority/head rechecks finish.
    let ref = access.db
      .selectFrom('blobs')
      .select('sha')
      .where('sha', '=', head.sha)
      .where('refs', '>', 0)
    if (deps.dialect === 'pg') ref = ref.forShare()
    if (!(await ref.executeTakeFirst())) throw missing()
    const content = await deps.store.verify(head.sha)
    if (!content || content.sha !== expected.sha || content.size !== expected.size) throw missing()
    const final = await authenticateToken(access, key)
    await activeScope(access, final)
    const current = await liveHead(access, final, fileId)
    if (
      current.version_id !== head.version_id ||
      current.path !== head.path ||
      current.sha !== head.sha ||
      current.size !== head.size
    )
      throw missing()
    return { verified: true, file_id: fileId, ...expected }
  })
}
