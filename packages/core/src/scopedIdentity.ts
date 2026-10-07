import { z } from 'zod'
import { normalizeServerUrl, credentialFacet } from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import { sha256, encodeText } from './hash.js'
import type { ClientOptions } from './http.js'
export const ScopedConnectionSchema = z
  .object({
    version: z.literal(4),
    facet: z.literal('scoped'),
    endpoint_identity: z
      .string()
      .max(2048)
      .refine((value) => normalizeServerUrl(value) === value),
    vault_id: z.string().min(1).max(200),
    grant_id: z.string().min(1).max(200),
    principal_kind: z.enum(['key', 'installation']),
    principal_id: z.string().min(1).max(200),
    credential_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type ScopedConnection = z.infer<typeof ScopedConnectionSchema>
export type ScopedClientOptions = ClientOptions & {
  vaultId: string
  grantId: string
  principalId: string
  principalKind: 'key' | 'installation'
}
export async function scopedIdentity(opts: ScopedClientOptions): Promise<ScopedConnection> {
  if (
    credentialFacet(opts.token) !== 'scoped' ||
    !opts.token.startsWith(opts.principalKind === 'key' ? 'absk_' : 'absi_')
  )
    throw new EngineError(
      'unauthorized',
      'the connection requires its exact scoped credential facet'
    )
  const endpoint = normalizeServerUrl(opts.baseUrl)
  if (!endpoint) throw new EngineError('protocol', 'invalid scoped issuer address')
  const parsed = ScopedConnectionSchema.safeParse({
    version: 4,
    facet: 'scoped',
    endpoint_identity: endpoint,
    vault_id: opts.vaultId,
    grant_id: opts.grantId,
    principal_kind: opts.principalKind,
    principal_id: opts.principalId,
    credential_fingerprint: await sha256(encodeText(opts.token)),
  })
  if (!parsed.success) throw new EngineError('protocol', 'invalid scoped connection binding')
  return Object.freeze(parsed.data)
}
export const sameScopedConnection = (left: ScopedConnection, right: ScopedConnection) =>
  JSON.stringify(left) === JSON.stringify(right)
