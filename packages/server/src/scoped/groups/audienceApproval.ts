import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
const Approval = z
  .object({
    kind: z.literal('audience-approval'),
    grantId: z.string().min(1).max(200),
    tokenKey: z.string().min(1).max(1024),
    originId: z.string().min(1).max(200),
  })
  .strict()
export function readAudienceApproval(raw: string | null) {
  try {
    const parsed = raw && raw.length <= 4096 ? Approval.safeParse(JSON.parse(raw)) : null
    return parsed?.success ? parsed.data : null
  } catch {
    return null
  }
}
/** A new vault-wide baseline does not prove that a token stayed present since
 * an old audience approval. Retire that mutable permission under the vault lock;
 * immutable origins and stable target identities are not rewritten. Owners can
 * approve the new certified preview explicitly after preparation completes.
 */
export async function retireGroupApprovals(tx: Transaction<Database>, vaultId: string) {
  await tx
    .updateTable('scope_group_bindings')
    .set({ approved_rebind_id: null })
    .where('vault_id', '=', vaultId)
    .where('approved_rebind_id', 'is not', null)
    .execute()
}

export function approvalBindingKey(grantId: string, tokenKey: string) {
  return `@approval:${grantId}:${createHash('sha256').update(tokenKey).digest('hex')}`
}
export function audienceApproval(grantId: string, tokenKey: string, originId: string) {
  return JSON.stringify(Approval.parse({ kind: 'audience-approval', grantId, tokenKey, originId }))
}
