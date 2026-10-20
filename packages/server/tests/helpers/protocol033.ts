// Frozen connection schema from abele-sync v0.3.3 (4b57c445).
// Keep independent of current selector and connection schemas.
import { z } from 'zod'

const id = z.string().min(1).max(200)
const integer = z.number().int().nonnegative().safe()
export const Connection033 = z
  .object({
    protocol: z.literal(2),
    token_id: id,
    read_only: z.boolean().optional(),
    space_id: id,
    scope: z
      .object({ kind: z.enum(['folder', 'group']), id, path: z.string().min(1).max(1024) })
      .strict(),
    status: z.enum(['active', 'scope_unavailable', 'scope_updating']),
    limits: z
      .object({ max_file_bytes: integer.positive(), quota_bytes: integer.nullable() })
      .strict(),
  })
  .strict()
