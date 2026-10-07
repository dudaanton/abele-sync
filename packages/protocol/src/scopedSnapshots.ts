import { z } from 'zod'
import { PrincipalIdSchema } from './principals.js'
import { PathSchema, ShaSchema } from './schemas.js'
import { ScopedCheckpointSchema } from './scopedV4.js'

export const ScopedManifestItemSchema = z
  .object({
    file_id: PrincipalIdSchema,
    version_id: PrincipalIdSchema,
    path: PathSchema,
    kind: z.enum(['note', 'canvas', 'attachment']),
    sha: ShaSchema,
    size: z.number().int().nonnegative().safe(),
    mtime: z.number().int().nonnegative().safe(),
  })
  .strict()
export type ScopedManifestItem = z.infer<typeof ScopedManifestItemSchema>
export const ScopedSnapshotPageSchema = z
  .object({
    snapshot_id: PrincipalIdSchema,
    items: z.array(ScopedManifestItemSchema).max(1000),
    cursor: z.string().min(1).max(4096),
    next_cursor: z.string().min(1).max(4096).nullable(),
    checkpoint: ScopedCheckpointSchema,
    /** Only the terminal page proves the complete identity inventory was delivered. */
    feed_checkpoint: ScopedCheckpointSchema.optional(),
  })
  .strict()
export type ScopedSnapshotPage = z.infer<typeof ScopedSnapshotPageSchema>
