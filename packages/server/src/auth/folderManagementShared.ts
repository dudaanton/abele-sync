import { AbeleError, SCOPED_LIMITS } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import { z } from 'zod'
import type { BlobStore } from '../blobs/store.js'
import type { Database } from '../db/schema.js'
import { newId } from '../ids.js'
import type { OwnerManagementDeps } from './freshOwner.js'

export interface FolderManagementDeps extends OwnerManagementDeps {
  store: Pick<BlobStore, 'sealPart' | 'openPart'>
  configurationDirectories?: readonly string[]
}
export const MAX_OWNER_KEYS = 64
export const MAX_KEY_ATTEMPTS = 256
export const RECOVERY_MS = 10 * 60 * 1000
export const GRANT_FIELDS = [
  'id',
  'vault_id',
  'label',
  'selector_kind',
  'folder_prefix',
  'root_file_id',
  'role',
  'state',
  'acl_revision',
  'scope_revision',
  'publication_revision',
  'created_at',
  'expires_at',
  'revoked_at',
] as const
export const KEY_FIELDS = [
  'id',
  'grant_id',
  'name',
  'role',
  'authority_revision',
  'created_at',
  'expires_at',
  'revoked_at',
  'last_seen_at',
] as const
export function request<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new AbeleError('invalid_request', 'invalid folder management request')
  return parsed.data
}
export function futureExpiry(raw: string | null | undefined, at: Date): string | null {
  if (raw === null || raw === undefined) return null
  const expiry = Date.parse(raw)
  if (!Number.isFinite(expiry) || expiry <= at.getTime())
    throw new AbeleError('invalid_request', 'future expiry required')
  return new Date(expiry).toISOString()
}
export async function requireGrantSlot(tx: Transaction<Database>, vaultId: string, at: Date) {
  const rows = await tx
    .selectFrom('scope_grants')
    .select('id')
    .where('vault_id', '=', vaultId)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())]))
    .limit(SCOPED_LIMITS.max_live_grants)
    .execute()
  if (rows.length >= SCOPED_LIMITS.max_live_grants)
    throw new AbeleError('too_large', 'live grant ceiling reached')
}
export async function requireKeySlot(tx: Transaction<Database>, grantId: string, at: Date) {
  const rows = await tx
    .selectFrom('scope_keys')
    .select('id')
    .where('grant_id', '=', grantId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', at.toISOString())
    .limit(MAX_OWNER_KEYS)
    .execute()
  if (rows.length >= MAX_OWNER_KEYS) throw new AbeleError('too_large', 'live key ceiling reached')
}
export async function managementAudit(
  tx: Transaction<Database>,
  accountId: string,
  vaultId: string,
  action: string,
  id: string,
  at: Date
) {
  await tx
    .insertInto('audit')
    .values({
      id: newId(),
      vault_id: vaultId,
      actor_kind: 'account',
      actor_id: accountId,
      action,
      path: null,
      result: 'applied',
      at: at.toISOString(),
      details: JSON.stringify({ id }),
    })
    .execute()
}
