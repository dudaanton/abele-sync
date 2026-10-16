// Frozen v0.3.1 strict response schemas. Do not derive these from the current v2 schemas.
import { z } from 'zod'
import { PathSchema } from '@abele/sync-protocol'

const id = z.string().min(1).max(200)
const integer = z.number().int().nonnegative().safe()
const timestamp = z.string().datetime({ offset: true })
const scope = z.object({ kind: z.enum(['folder', 'group']), id, path: PathSchema }).strict()
export const Connection031 = z
  .object({
    protocol: z.literal(2),
    token_id: id,
    space_id: id,
    scope,
    status: z.enum(['active', 'scope_unavailable', 'scope_updating']),
    limits: z
      .object({ max_file_bytes: integer.positive(), quota_bytes: integer.nullable() })
      .strict(),
  })
  .strict()
export const TokenInfo031 = z
  .object({
    id,
    scope,
    label: z.string(),
    issued_by_token_id: id.nullable(),
    created_at: timestamp,
    revoked_at: timestamp.nullable(),
  })
  .strict()
