import {
  AbeleError,
  ExternalVerifyRequestSchema,
  ManifestItemSchema,
  validatePath,
  type ExternalVerifyRequest,
  type ExternalVerifyResponse,
  type ManifestItem,
} from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import { lockAccounts } from '../auth/accountFence.js'
import { authNow, type AuthDeps } from '../auth/accounts.js'
import { authenticateDevice } from '../auth/devices.js'
import type { BlobStore } from '../blobs/store.js'
import type { Dialect } from '../db/connect.js'
import type { Database } from '../db/schema.js'
import { withVaultLock } from '../oplog/lock.js'
import { folderVersionInTransaction } from '../scoped/admissions.js'
import { withScopedAuthority, type ScopedDeps } from '../scoped/authority.js'
import { isMember } from './vaults.js'

export interface ExternalFilesDeps extends ScopedDeps {
  store: BlobStore
}
const missing = () => new AbeleError('not_found', 'no verifiable live file')

/** Account → vault → device/membership → blob. The final authentication is not
 * merely a pre-handler check. PG row locks also close the final-read/commit window
 * against all existing device-revoke UPDATE paths. SQLite's transaction serializes.
 */
async function withPersonalRead<T>(
  deps: AuthDeps & { dialect: Dialect },
  token: string,
  vault: string,
  run: (tx: Transaction<Database>) => Promise<T>
): Promise<T> {
  const first = await authenticateDevice(deps, token)
  if (first.vaultId !== vault)
    throw new AbeleError('forbidden', 'that device belongs to another vault')
  return withVaultLock(
    deps.db,
    deps.dialect,
    vault,
    async (tx) => {
      if (deps.dialect === 'pg') {
        await tx.selectFrom('vaults').select('id').where('id', '=', vault).forShare().execute()
        await tx
          .selectFrom('devices')
          .select('id')
          .where('id', '=', first.deviceId)
          .forUpdate()
          .execute()
        await tx
          .selectFrom('vault_members')
          .select('account_id')
          .where('vault_id', '=', vault)
          .where('account_id', '=', first.accountId)
          .forShare()
          .execute()
      }
      const bound = { ...deps, db: tx }
      const check = async () => {
        const current = await authenticateDevice(bound, token)
        if (
          current.deviceId !== first.deviceId ||
          current.accountId !== first.accountId ||
          current.vaultId !== vault
        )
          throw new AbeleError('unauthorized', 'device authority changed')
        if (!(await isMember(tx, vault, current.accountId)))
          throw new AbeleError('forbidden', 'vault membership is unavailable')
      }
      await check()
      const result = await run(tx)
      await check()
      return result
    },
    (tx) => lockAccounts(tx, [first.accountId])
  )
}

/** Authoritative live head, never a materialized scoped member or a historical version. */
async function liveHead(
  tx: Transaction<Database>,
  vault: string,
  file: string
): Promise<ManifestItem> {
  const row = await tx
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
    .where('f.vault_id', '=', vault)
    .where('f.id', '=', file)
    .where('f.deleted_at', 'is', null)
    .where('v.vault_id', '=', vault)
    .where('v.file_id', '=', file)
    .where('v.op', '!=', 'delete')
    .executeTakeFirst()
  if (!row || row.path !== row.version_path) throw missing()
  const parsed = ManifestItemSchema.safeParse(row)
  if (!parsed.success) throw missing()
  return parsed.data
}
function expected(input: unknown): ExternalVerifyRequest {
  const value = ExternalVerifyRequestSchema.parse(input)
  validatePath(value.path)
  return value
}
async function verifyBlob(
  tx: Transaction<Database>,
  deps: ExternalFilesDeps,
  head: ManifestItem,
  input: ExternalVerifyRequest
): Promise<ExternalVerifyResponse> {
  if (
    head.version_id !== input.version_id ||
    head.path !== input.path ||
    head.sha !== input.sha ||
    head.size !== input.size
  )
    throw missing()
  // GC claims reference rows before removing bytes. Hold the reference row through
  // integrity verification and final authority recheck, after all authority locks.
  let query = tx.selectFrom('blobs').select('sha').where('sha', '=', head.sha).where('refs', '>', 0)
  if (deps.dialect === 'pg') query = query.forShare()
  if (!(await query.executeTakeFirst())) throw missing()
  const content = await deps.store.verify(head.sha)
  if (!content || content.size !== input.size) throw missing()
  return { verified: true, file_id: head.file_id, ...input }
}
export async function personalHead(
  deps: ExternalFilesDeps,
  token: string,
  vault: string,
  file: string
) {
  return withPersonalRead(deps, token, vault, (tx) => liveHead(tx, vault, file))
}
export async function verifyPersonalFile(
  deps: ExternalFilesDeps,
  token: string,
  vault: string,
  file: string,
  input: unknown
) {
  return withPersonalRead(deps, token, vault, async (tx) =>
    verifyBlob(tx, deps, await liveHead(tx, vault, file), expected(input))
  )
}
export async function verifyScopedFile(
  deps: ExternalFilesDeps,
  token: string,
  vault: string,
  grant: string,
  file: string,
  input: unknown
) {
  return withScopedAuthority(deps, token, vault, grant, 'read', async (tx, a) => {
    const value = expected(input)
    await folderVersionInTransaction(tx, a, file, value.version_id, authNow(deps), deps)
    const head = await liveHead(tx, vault, file)
    const member = await tx
      .selectFrom('scope_current_members')
      .select(['version_id', 'path', 'sha', 'size'])
      .where('vault_id', '=', vault)
      .where('grant_id', '=', grant)
      .where('file_id', '=', file)
      .executeTakeFirst()
    if (
      !member ||
      member.version_id !== head.version_id ||
      member.path !== head.path ||
      member.sha !== head.sha ||
      member.size !== head.size
    )
      throw missing()
    return verifyBlob(tx, deps, head, value)
  })
}
