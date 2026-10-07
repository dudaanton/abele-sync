import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AbeleError, ShaSchema } from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { hasRoom } from '../blobs/pending.js'
import { SEAL_OVERHEAD } from '../blobs/store.js'
import { newId } from '../ids.js'
import { withScopedAuthority, type ScopedAuthority } from './authority.js'
import { SCOPED_UPLOAD_LIMITS, requireScopedPendingRoom, type ScopedUploadDeps } from './uploads.js'

export const SCOPED_MULTIPART_LIMITS = Object.freeze({
  partBytes: 1024 * 1024,
  maxBytes: 200 * 1024 * 1024,
  maxParts: 200,
  maxInProgress: 8,
  maxPendingBytes: 256 * 1024 * 1024,
})
const absent = () => new AbeleError('not_found', 'no authorized upload')
const owned = (a: ScopedAuthority) => ({
  vault_id: a.principal.vault_id,
  grant_id: a.principal.grant_id,
  principal_kind: a.principal.kind,
  principal_id: a.principal.principal_id,
  key_id: a.principal.kind === 'key' ? a.principal.principal_id : null,
  installation_id: a.principal.kind === 'installation' ? a.principal.principal_id : null,
})
const directory = (deps: ScopedUploadDeps, id: string) =>
  join(deps.store.dir, 'scoped-upload-parts', id)
const label = (id: string, index: number) => `scoped-upload:${id}:${index}`
const count = (size: number, part: number) => Math.ceil(size / part)
function claimed(row: { size: number; part_size: number }, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count(row.size, row.part_size))
    throw new AbeleError('invalid_request', 'invalid part number')
  return Math.min(row.part_size, row.size - index * row.part_size)
}
async function present(
  deps: ScopedUploadDeps,
  row: { id: string; size: number; part_size: number }
): Promise<number[]> {
  const received: number[] = []
  for (let i = 0; i < count(row.size, row.part_size); i++) {
    const file = await stat(join(directory(deps, row.id), String(i))).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      }
    )
    if (file?.isFile() && file.size === claimed(row, i) + SEAL_OVERHEAD) received.push(i)
  }
  return received
}
export async function beginScopedUpload(
  deps: ScopedUploadDeps,
  token: string,
  vaultId: string,
  grantId: string,
  sha: string,
  size: number
) {
  return withScopedAuthority(deps, token, vaultId, grantId, 'stage', async (tx, a) => {
    if (!ShaSchema.safeParse(sha).success || !Number.isSafeInteger(size) || size <= 0)
      throw new AbeleError('invalid_request', 'invalid upload description')
    if (
      size > SCOPED_MULTIPART_LIMITS.maxBytes ||
      count(size, SCOPED_MULTIPART_LIMITS.partBytes) > SCOPED_MULTIPART_LIMITS.maxParts
    )
      throw new AbeleError('too_large', 'scoped multipart limit exceeded')
    const at = authNow(deps),
      identity = owned(a)
    const rows = await tx
      .selectFrom('scope_uploads')
      .select(['id', 'sha', 'size', 'part_size', 'expires_at'])
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where('grant_id', '=', grantId)
      .where('expires_at', '>', at.toISOString())
      .limit(SCOPED_MULTIPART_LIMITS.maxInProgress + 1)
      .execute()
    const same = rows.find((row) => row.sha === sha && row.size === size)
    if (same)
      return {
        upload_id: same.id,
        part_size: same.part_size,
        parts: count(size, same.part_size),
        received: await present(deps, same),
      }
    if (
      rows.length >= SCOPED_MULTIPART_LIMITS.maxInProgress ||
      rows.reduce((sum, row) => sum + row.size, 0) + size > SCOPED_MULTIPART_LIMITS.maxPendingBytes
    )
      throw new AbeleError('quota_waiting', 'scoped multipart budget reached')
    await requireScopedPendingRoom(tx, a, sha, size, at, undefined, true)
    const proved = await tx
      .selectFrom('scope_blob_uploads')
      .select('sha')
      .where('vault_id', '=', vaultId)
      .where('grant_id', '=', grantId)
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where('sha', '=', sha)
      .where('size', '=', size)
      .where('expires_at', '>', at.toISOString())
      .executeTakeFirst()
    try {
      await hasRoom(tx, vaultId, sha, size, at, undefined, !!proved)
    } catch (error) {
      if (error instanceof AbeleError) throw new AbeleError(error.code, 'upload budget unavailable')
      throw error
    }
    const id = newId()
    await tx
      .insertInto('scope_uploads')
      .values({
        ...identity,
        id,
        sha,
        size,
        part_size: SCOPED_MULTIPART_LIMITS.partBytes,
        parts_received: '[]',
        created_at: at.toISOString(),
        expires_at: new Date(at.getTime() + SCOPED_UPLOAD_LIMITS.lifetimeMs).toISOString(),
        completing_at: null,
      })
      .execute()
    return {
      upload_id: id,
      part_size: SCOPED_MULTIPART_LIMITS.partBytes,
      parts: count(size, SCOPED_MULTIPART_LIMITS.partBytes),
      received: [],
    }
  })
}
async function rowFor(deps: ScopedUploadDeps, a: ScopedAuthority, id: string) {
  const row = await deps.db
    .selectFrom('scope_uploads')
    .selectAll()
    .where('id', '=', id)
    .where('vault_id', '=', a.principal.vault_id)
    .where('grant_id', '=', a.principal.grant_id)
    .where('principal_kind', '=', a.principal.kind)
    .where('principal_id', '=', a.principal.principal_id)
    .where('expires_at', '>', authNow(deps).toISOString())
    .executeTakeFirst()
  if (!row) throw absent()
  return row
}
export async function putScopedPart(
  deps: ScopedUploadDeps,
  token: string,
  vaultId: string,
  grantId: string,
  id: string,
  index: number,
  bytes: Uint8Array
): Promise<void> {
  await withScopedAuthority(deps, token, vaultId, grantId, 'stage', async (tx, a) => {
    const row = await rowFor({ ...deps, db: tx }, a, id)
    if (row.completing_at !== null) throw new AbeleError('conflict', 'upload is completing')
    if (bytes.byteLength !== claimed(row, index))
      throw new AbeleError('invalid_request', 'wrong part length')
    const dir = directory(deps, id),
      file = join(dir, String(index)),
      temporary = join(dir, `${index}.${randomUUID()}.tmp`)
    await mkdir(dir, { recursive: true })
    try {
      await writeFile(temporary, deps.store.sealPart(bytes, label(id, index)), { flag: 'wx' })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
    const received = await present(deps, row)
    await tx
      .updateTable('scope_uploads')
      .set({ parts_received: JSON.stringify(received) })
      .where('id', '=', id)
      .execute()
  })
}
export async function completeScopedUpload(
  deps: ScopedUploadDeps,
  token: string,
  vaultId: string,
  grantId: string,
  id: string
) {
  return withScopedAuthority(deps, token, vaultId, grantId, 'stage', async (tx, a) => {
    const row = await rowFor({ ...deps, db: tx }, a, id)
    if ((await present(deps, row)).length !== count(row.size, row.part_size))
      throw new AbeleError('invalid_request', 'upload has missing parts')
    await tx
      .updateTable('scope_uploads')
      .set({ completing_at: authNow(deps).toISOString() })
      .where('id', '=', id)
      .execute()
    const at = authNow(deps)
    // Parts are owned and sealed, but their aggregate SHA is still a claim.
    // Prove it with bounded streaming before quota or shared blob-row decisions.
    const hash = createHash('sha256')
    for (let i = 0; i < count(row.size, row.part_size); i++) {
      const bytes = deps.store.openPart(
        await readFile(join(directory(deps, id), String(i))),
        label(id, i)
      )
      if (!bytes || bytes.length !== claimed(row, i))
        throw new AbeleError('invalid_request', 'missing or corrupt upload part')
      hash.update(bytes)
    }
    if (hash.digest('hex') !== row.sha)
      throw new AbeleError('hash_mismatch', 'upload bytes changed')
    await requireScopedPendingRoom(tx, a, row.sha, row.size, at, id)
    try {
      await hasRoom(tx, vaultId, row.sha, row.size, at, row.id)
    } catch (error) {
      if (error instanceof AbeleError) throw new AbeleError(error.code, 'upload budget unavailable')
      throw error
    }
    const blob = await tx
      .insertInto('blobs')
      .values({
        sha: row.sha,
        size: row.size,
        storage_ref: deps.store.pathFor(row.sha),
        refs: 0,
        created_at: at.toISOString(),
        last_referenced_at: at.toISOString(),
      })
      .onConflict((oc) =>
        oc
          .column('sha')
          .doUpdateSet({ last_referenced_at: at.toISOString() })
          .where('blobs.refs', '>=', 0)
      )
      .returning('sha')
      .executeTakeFirst()
    if (!blob) throw absent()
    const opened = async function* () {
      for (let i = 0; i < count(row.size, row.part_size); i++) {
        const bytes = deps.store.openPart(
          await readFile(join(directory(deps, id), String(i))),
          label(id, i)
        )
        if (!bytes || bytes.length !== claimed(row, i))
          throw new AbeleError('invalid_request', 'missing or corrupt upload part')
        yield bytes
      }
    }
    const stored = await deps.store.putChunks(row.sha, opened)
    if (stored.size !== row.size) throw new AbeleError('hash_mismatch', 'upload bytes changed')
    await tx
      .insertInto('scope_blob_uploads')
      .values({
        ...owned(a),
        sha: row.sha,
        size: row.size,
        created_at: at.toISOString(),
        expires_at: new Date(at.getTime() + SCOPED_UPLOAD_LIMITS.lifetimeMs).toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(['vault_id', 'sha', 'principal_kind', 'principal_id']).doUpdateSet({
          expires_at: new Date(at.getTime() + SCOPED_UPLOAD_LIMITS.lifetimeMs).toISOString(),
        })
      )
      .execute()
    await tx.deleteFrom('scope_uploads').where('id', '=', id).execute()
    return { sha: row.sha, size: row.size }
  }).then(async (result) => {
    await rm(directory(deps, id), { recursive: true, force: true })
    return result
  })
}
