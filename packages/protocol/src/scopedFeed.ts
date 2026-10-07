import { z } from 'zod'
import { PrincipalIdSchema } from './principals.js'
import { ScopedManifestItemSchema } from './scopedSnapshots.js'
import { ScopedCheckpointSchema } from './scopedV4.js'

export const ScopedFeedEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('content'), file: ScopedManifestItemSchema }).strict(),
  z.object({ type: z.literal('deleted'), file_id: PrincipalIdSchema }).strict(),
  z.object({ type: z.literal('departed'), file_id: PrincipalIdSchema }).strict(),
])
export type ScopedFeedEvent = z.infer<typeof ScopedFeedEventSchema>
export const ScopedFeedPageSchema = z
  .object({
    events: z.array(ScopedFeedEventSchema).max(1000),
    checkpoint: ScopedCheckpointSchema,
    has_more: z.boolean(),
  })
  .strict()
export type ScopedFeedPage = z.infer<typeof ScopedFeedPageSchema>
