import { createHash } from 'node:crypto'
import {
  AbeleError,
  ScopedCommitRequestSchema,
  ScopedCommitResponseSchema,
  type ScopedCommitResponse,
} from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { newId } from '../ids.js'
import { headSeqOf } from '../oplog/changes.js'
import type { EventHub } from '../events/hub.js'
import type { ScopedMergeInputDeps } from './mergeInputs.js'
import { withScopedAuthority, type ScopedAuthority } from './authority.js'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { operationsInTransaction } from './operations.js'
import { serializeScopedResult } from './outputContext.js'
import { folderVersionInTransaction } from './admissions.js'
import { groupWriteCertificate, type GroupWriteAuthority } from './groups/writeCertificate.js'

export type ScopedCommitDeps = ScopedMergeInputDeps & {
  endpointIdentity?: string
  config?: { publicUrl?: string }
  hub?: EventHub
}
const PAYLOAD_MS = 24 * 60 * 60 * 1000,
  MAX_PAYLOADS = 64,
  MAX_RESPONSE_BYTES = 128 * 1024
/** Durable outcome identity never expires with its bounded metadata payload. */
export async function commitScoped(
  deps: ScopedCommitDeps,
  token: string,
  vaultId: string,
  grantId: string,
  requestId: string,
  input: unknown,
  validateNew?: (tx: Transaction<Database>, authority: ScopedAuthority) => Promise<void>
): Promise<ScopedCommitResponse> {
  const parsed = ScopedCommitRequestSchema.safeParse({ request_id: requestId, ops: input })
  if (!parsed.success) throw new AbeleError('invalid_request', 'invalid scoped commit')
  const ops = parsed.data.ops,
    hash = createHash('sha256').update(JSON.stringify(ops)).digest('hex'),
    endpoint = deps.endpointIdentity ?? deps.config?.publicUrl ?? 'local'
  if (endpoint.length > 2048) throw new AbeleError('invalid_request', 'invalid endpoint binding')
  const published = await withScopedAuthority(
    deps,
    token,
    vaultId,
    grantId,
    'receipt',
    async (tx, a) => {
      const at = authNow(deps),
        identity = {
          vault_id: vaultId,
          grant_id: grantId,
          principal_kind: a.principal.kind,
          principal_id: a.principal.principal_id,
          key_id: a.principal.kind === 'key' ? a.principal.principal_id : null,
          installation_id: a.principal.kind === 'installation' ? a.principal.principal_id : null,
        }
      const existing = await tx
        .selectFrom('scope_receipts')
        .selectAll()
        .where('vault_id', '=', vaultId)
        .where('grant_id', '=', grantId)
        .where('principal_kind', '=', a.principal.kind)
        .where('principal_id', '=', a.principal.principal_id)
        .where('endpoint_identity', '=', endpoint)
        .where('request_id', '=', requestId)
        .executeTakeFirst()
      if (existing) {
        if (existing.request_hash !== hash)
          throw new AbeleError(
            'idempotency_mismatch',
            'request identity was used for different operations'
          )
        const compact = { outcome_id: existing.outcome_id, acknowledged: true, results: [] }
        if (
          existing.response === null ||
          existing.payload_expires_at <= at.toISOString() ||
          a.state !== 'active' ||
          existing.response.length > MAX_RESPONSE_BYTES
        )
          return { response: compact, headSeq: null }
        const stored = ScopedCommitResponseSchema.safeParse(JSON.parse(existing.response))
        if (!stored.success) return { response: compact, headSeq: null }
        try {
          for (const result of stored.data.results) {
            if (result.status === 'acknowledged') continue
            await folderVersionInTransaction(
              tx,
              a,
              result.file_id,
              result.version_id,
              authNow(deps),
              deps
            )
            if (result.status === 'conflict')
              await folderVersionInTransaction(
                tx,
                a,
                result.conflict_file_id,
                result.conflict_version_id,
                authNow(deps),
                deps
              )
          }
        } catch (error) {
          if (
            error instanceof AbeleError &&
            (error.code === 'not_found' ||
              error.code === 'scope_unavailable' ||
              error.code === 'scope_updating')
          )
            return { response: compact, headSeq: null }
          throw error
        }
        return { response: stored.data, headSeq: null }
      }
      if (a.role !== 'editor') throw new AbeleError('forbidden', 'editor authority is required')
      if (a.state !== 'active') throw new AbeleError('scope_updating', 'folder view is preparing')
      const writing: GroupWriteAuthority =
        a.selector.kind === 'group' ? { ...a, [groupWriteCertificate]: true } : a
      // Internal exact-proof checks share the receipt/write/consumption fence;
      // replays above intentionally do not require an already consumed upload.
      await validateNew?.(tx, writing)
      const raw = await operationsInTransaction(tx, writing, deps, ops)
      const response = ScopedCommitResponseSchema.parse({
        outcome_id: newId(),
        acknowledged: false,
        results: await Promise.all(
          raw.map((result) => serializeScopedResult(tx, writing, deps, result))
        ),
      })
      const body = JSON.stringify(response)
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
        throw new AbeleError('too_large', 'scoped result budget reached')
      // Bound payload storage without deleting durable replay identities.
      const payloads = await tx
        .selectFrom('scope_receipts')
        .select(['request_id', 'endpoint_identity'])
        .where('principal_kind', '=', a.principal.kind)
        .where('principal_id', '=', a.principal.principal_id)
        .where('response', 'is not', null)
        .orderBy('created_at', 'desc')
        .orderBy('request_id', 'desc')
        .offset(MAX_PAYLOADS - 1)
        .limit(MAX_PAYLOADS + 1)
        .execute()
      if (payloads.length > MAX_PAYLOADS)
        throw new AbeleError('scope_unavailable', 'receipt payload budget needs cleanup')
      for (const old of payloads)
        await tx
          .updateTable('scope_receipts')
          .set({ response: null })
          .where('principal_kind', '=', a.principal.kind)
          .where('principal_id', '=', a.principal.principal_id)
          .where('endpoint_identity', '=', old.endpoint_identity)
          .where('request_id', '=', old.request_id)
          .execute()
      await tx
        .insertInto('scope_receipts')
        .values({
          ...identity,
          endpoint_identity: endpoint,
          request_id: requestId,
          request_hash: hash,
          outcome_id: response.outcome_id,
          status: 200,
          response: body,
          created_at: at.toISOString(),
          payload_expires_at: new Date(at.getTime() + PAYLOAD_MS).toISOString(),
        })
        .execute()
      return { response, headSeq: await headSeqOf(tx, vaultId) }
    },
    { publishViewChanges: true }
  )
  if (published.headSeq !== null) deps.hub?.notify(vaultId, published.headSeq)
  return ScopedCommitResponseSchema.parse(published.response)
}
