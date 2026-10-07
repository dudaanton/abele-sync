import { z } from 'zod'
import { PathSchema, ShaSchema, VersionOpSchema } from './schemas.js'
const id = z.string().min(1).max(200),
  cursor = z.string().min(1).max(4096).nullable()
export const ScopedHistoryPageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            version_id: id,
            op: VersionOpSchema,
            path: PathSchema,
            sha: ShaSchema.nullable(),
            size: z.number().int().nonnegative().safe(),
            mtime: z.number().int().nonnegative().safe(),
          })
          .strict()
      )
      .max(1000),
    next_cursor: cursor,
  })
  .strict()
export const ScopedTrashPageSchema = z
  .object({
    items: z
      .array(
        z.object({ file_id: id, last_version_id: id, deleted_at: z.string().datetime() }).strict()
      )
      .max(1000),
    next_cursor: cursor,
  })
  .strict()
export type ScopedHistoryPage = z.infer<typeof ScopedHistoryPageSchema>
export type ScopedTrashPage = z.infer<typeof ScopedTrashPageSchema>
