import { createHash } from 'node:crypto'
import {
  AbeleError,
  IssueFolderKeyRequestSchema,
  UpdateFolderKeyRequestSchema,
} from '@abele/sync-protocol'
import { sql } from 'kysely'
import { newId } from '../ids.js'
import { authNow } from './accounts.js'
import {
  activeFirst,
  liveAt,
  ownerGrant as selectOwnerGrant,
  withOwnerManagement,
} from './freshOwner.js'
const ownerGrant = (...args: Parameters<typeof selectOwnerGrant>) =>
  selectOwnerGrant(args[0], args[1], args[2], args[3], 'any')
import { hashToken, newToken } from './hash.js'
import {
  KEY_FIELDS,
  MAX_KEY_ATTEMPTS,
  RECOVERY_MS,
  futureExpiry,
  managementAudit,
  request,
  requireKeySlot,
  type FolderManagementDeps,
} from './folderManagementShared.js'

const label = (owner: string, grant: string, attempt: string) =>
  `v4-folder-key:${owner}:${grant}:${attempt}`
const liveGrant = (grant: { revoked_at: string | null; expires_at: string | null }, at: Date) => {
  if (grant.revoked_at !== null || !liveAt(grant.expires_at, at))
    throw new AbeleError('conflict', 'grant is retired')
}
const ceiling = (grant: 'reader' | 'editor', key: 'reader' | 'editor') => {
  if (grant === 'reader' && key === 'editor')
    throw new AbeleError('forbidden', 'key role exceeds grant ceiling')
}
export async function listFolderKeys(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  grantId: string
) {
  return withOwnerManagement(deps, token, vaultId, async (tx) => {
    const grant = await ownerGrant(tx, vaultId, grantId, deps.dialect)
    const keys = await tx
      .selectFrom('scope_keys')
      .select(KEY_FIELDS)
      .where('grant_id', '=', grantId)
      .orderBy(activeFirst(authNow(deps)))
      .orderBy('created_at')
      .orderBy('id')
      .limit(64)
      .execute()
    const at = authNow(deps)
    return keys.map((key) => ({
      ...key,
      effective_role: grant.role === 'reader' ? ('reader' as const) : key.role,
      credential_live:
        grant.revoked_at === null &&
        key.revoked_at === null &&
        liveAt(grant.expires_at, at) &&
        liveAt(key.expires_at, at),
    }))
  })
}
export async function issueFolderKey(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  grantId: string,
  input: unknown
) {
  const body = request(IssueFolderKeyRequestSchema, input)
  const normal = { ...body, expires_at: new Date(body.expires_at).toISOString() }
  const hash = createHash('sha256').update(JSON.stringify(normal)).digest('hex')
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const grant = await ownerGrant(tx, vaultId, grantId, deps.dialect),
      at = authNow(deps)
    liveGrant(grant, at)
    ceiling(grant.role, body.role)
    const existing = await tx
      .selectFrom('scope_key_issuances')
      .selectAll()
      .where('account_id', '=', session.accountId)
      .where('grant_id', '=', grantId)
      .where('attempt_id', '=', body.attempt_id)
      .executeTakeFirst()
    const boundLabel = label(session.accountId, grantId, body.attempt_id)
    if (existing) {
      if (existing.request_hash !== hash)
        throw new AbeleError('idempotency_mismatch', 'issuance attempt changed')
      const key = await tx
        .selectFrom('scope_keys')
        .select(['revoked_at', 'expires_at'])
        .where('id', '=', existing.key_id)
        .where('grant_id', '=', grantId)
        .executeTakeFirst()
      if (
        !key ||
        key.revoked_at !== null ||
        !liveAt(key.expires_at, at) ||
        existing.retired_at !== null ||
        !liveAt(existing.expires_at, at) ||
        existing.protected_token === null
      ) {
        throw new AbeleError(
          'conflict',
          'issuance recovery retired; inspect the key before replacing it',
          { key_id: existing.key_id }
        )
      }
      const recovered = deps.store.openPart(
        Buffer.from(existing.protected_token, 'base64'),
        boundLabel
      )
      if (!recovered || !/^absk_[A-Za-z0-9_-]{43}$/.test(recovered.toString('utf8')))
        throw new AbeleError('internal', 'issuance recovery unavailable')
      const finalAt = authNow(deps)
      liveGrant(grant, finalAt)
      if (!liveAt(key.expires_at, finalAt) || !liveAt(existing.expires_at, finalAt))
        throw new AbeleError('conflict', 'issuance recovery expired')
      return { key_id: existing.key_id, key_token: recovered.toString('utf8') }
    }
    const expiry = futureExpiry(body.expires_at, at)!
    await requireKeySlot(tx, grantId, at)
    const attempts = await tx
      .selectFrom('scope_key_issuances')
      .select('attempt_id')
      .where('grant_id', '=', grantId)
      .limit(MAX_KEY_ATTEMPTS)
      .execute()
    if (attempts.length >= MAX_KEY_ATTEMPTS)
      throw new AbeleError('too_large', 'issuance outcome ceiling reached')
    const id = newId(),
      secret = newToken('absk')
    await tx
      .insertInto('scope_keys')
      .values({
        id,
        grant_id: grantId,
        owner_account_id: session.accountId,
        name: body.name,
        token_hash: hashToken(deps.pepper, secret),
        role: body.role,
        created_at: at.toISOString(),
        expires_at: expiry,
        revoked_at: null,
        last_seen_at: null,
      })
      .execute()
    await tx
      .insertInto('scope_key_issuances')
      .values({
        account_id: session.accountId,
        grant_id: grantId,
        attempt_id: body.attempt_id,
        key_id: id,
        request_hash: hash,
        protected_token: deps.store.sealPart(Buffer.from(secret), boundLabel).toString('base64'),
        session_hash: session.sessionHash,
        authenticated_at: session.authenticatedAt,
        created_at: at.toISOString(),
        expires_at: new Date(at.getTime() + RECOVERY_MS).toISOString(),
        retired_at: null,
      })
      .execute()
    await managementAudit(tx, session.accountId, vaultId, 'scope.key.issue', id, at)
    liveGrant(grant, authNow(deps))
    futureExpiry(expiry, authNow(deps))
    return { key_id: id, key_token: secret }
  })
}
export async function updateFolderKey(
  deps: FolderManagementDeps,
  token: string,
  vaultId: string,
  grantId: string,
  keyId: string,
  input: unknown
) {
  const body = request(UpdateFolderKeyRequestSchema, input)
  return withOwnerManagement(deps, token, vaultId, async (tx, session) => {
    const grant = await ownerGrant(tx, vaultId, grantId, deps.dialect),
      at = authNow(deps)
    let query = tx
      .selectFrom('scope_keys')
      .selectAll()
      .where('id', '=', keyId)
      .where('grant_id', '=', grantId)
    if (deps.dialect === 'pg') query = query.forUpdate()
    const key = await query.executeTakeFirst()
    if (!key) throw new AbeleError('not_found', 'no folder key')
    if (key.authority_revision !== body.expected_revision)
      throw new AbeleError('conflict', 'key preview changed')
    if (!body.revoke) {
      liveGrant(grant, at)
      if (key.revoked_at !== null) throw new AbeleError('conflict', 'key is retired')
    }
    if (body.role !== undefined) ceiling(grant.role, body.role)
    const expiry = body.expires_at === undefined ? undefined : futureExpiry(body.expires_at, at)!
    if (!body.revoke && expiry !== undefined && !liveAt(key.expires_at, at))
      await requireKeySlot(tx, grantId, at)
    await tx
      .updateTable('scope_keys')
      .set({
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.role === undefined ? {} : { role: body.role }),
        ...(expiry === undefined ? {} : { expires_at: expiry }),
        ...(body.revoke ? { revoked_at: key.revoked_at ?? at.toISOString() } : {}),
        authority_revision: sql<number>`authority_revision + 1`,
      })
      .where('id', '=', keyId)
      .execute()
    await tx
      .updateTable('scope_key_issuances')
      .set({ protected_token: null, retired_at: at.toISOString() })
      .where('key_id', '=', keyId)
      .execute()
    await tx
      .updateTable('scope_snapshots')
      .set({ state: 'invalidated' })
      .where('grant_id', '=', grantId)
      .where('principal_kind', '=', 'key')
      .where('principal_id', '=', keyId)
      .execute()
    if (body.revoke) {
      await tx
        .deleteFrom('scope_blob_uploads')
        .where('principal_kind', '=', 'key')
        .where('principal_id', '=', keyId)
        .where('grant_id', '=', grantId)
        .execute()
      await tx
        .deleteFrom('scope_uploads')
        .where('principal_kind', '=', 'key')
        .where('principal_id', '=', keyId)
        .where('grant_id', '=', grantId)
        .execute()
    }
    await managementAudit(
      tx,
      session.accountId,
      vaultId,
      body.revoke ? 'scope.key.revoke' : 'scope.key.update',
      keyId,
      at
    )
    if (!body.revoke) {
      liveGrant(grant, authNow(deps))
      if (expiry !== undefined) futureExpiry(expiry, authNow(deps))
    }
    return tx
      .selectFrom('scope_keys')
      .select(KEY_FIELDS)
      .where('id', '=', keyId)
      .executeTakeFirstOrThrow()
  })
}
