import { z } from 'zod'

/** Bounded stable IDs, never display paths or blob hashes used as authority. */
export const PrincipalIdSchema = z.string().min(1).max(200)
const id = PrincipalIdSchema
const identity = { principal_id: id, account_id: id }
const account = z
  .object({ kind: z.literal('account'), facet: z.literal('account'), ...identity })
  .strict()
const device = z
  .object({ kind: z.literal('device'), facet: z.literal('device'), ...identity, vault_id: id })
  .strict()
const key = z
  .object({
    kind: z.literal('key'),
    facet: z.literal('scoped'),
    ...identity,
    vault_id: id,
    grant_id: id,
  })
  .strict()
const installation = z
  .object({
    kind: z.literal('installation'),
    facet: z.literal('scoped'),
    ...identity,
    vault_id: id,
    grant_id: id,
    member_id: id,
  })
  .strict()

/** Disjoint principal identities. Parsing is not authentication/liveness. */
export const PrincipalSchema = z
  .discriminatedUnion('kind', [account, device, key, installation])
  .readonly()
export type Principal = z.infer<typeof PrincipalSchema>
export const ScopedPrincipalSchema = z.discriminatedUnion('kind', [key, installation]).readonly()
export type ScopedPrincipal = z.infer<typeof ScopedPrincipalSchema>

/** Disjoint credential namespaces. A scoped credential never retries as device/account. */
export function credentialFacet(token: string): Principal['facet'] | null {
  const prefix = /^(abst|absd|absk|absi)_[A-Za-z0-9_-]{43}$/.exec(token)?.[1]
  if (prefix === 'abst') return 'account'
  if (prefix === 'absd') return 'device'
  if (prefix === 'absk' || prefix === 'absi') return 'scoped'
  return null
}
