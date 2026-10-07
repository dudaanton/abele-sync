import { z } from 'zod'
import { ScopedGrantSelectorSchema, ScopedRoleSchema } from './scopedV4.js'
import { normalizeServerUrl } from './serverUrl.js'
const id = z.string().min(1).max(200)
export const ScopedStateResponseSchema = z
  .object({
    endpoint_identity: z
      .string()
      .max(2048)
      .refine((value) => normalizeServerUrl(value) === value),
    vault_id: id,
    grant_id: id,
    principal_kind: z.enum(['key', 'installation']),
    principal_id: id,
    role: ScopedRoleSchema,
    state: z.enum(['preparing', 'active']),
    selector: ScopedGrantSelectorSchema,
  })
  .strict()
export type ScopedStateResponse = z.infer<typeof ScopedStateResponseSchema>
