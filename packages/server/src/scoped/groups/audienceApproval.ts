import { z } from 'zod'
import { createHash } from 'node:crypto'
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
export function approvalBindingKey(grantId: string, tokenKey: string) {
  return `@approval:${grantId}:${createHash('sha256').update(tokenKey).digest('hex')}`
}
export function audienceApproval(grantId: string, tokenKey: string, originId: string) {
  return JSON.stringify(Approval.parse({ kind: 'audience-approval', grantId, tokenKey, originId }))
}
