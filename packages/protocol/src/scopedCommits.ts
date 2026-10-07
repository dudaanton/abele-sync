import { z } from 'zod'
import { CommitOpSchema, CommitOpResultSchema } from './schemas.js'
const id = z.string().min(1).max(200)
export const ScopedCommitOpSchema = z.discriminatedUnion('op', [
  CommitOpSchema.options[0]
    .omit({ prefer: true })
    .extend({
      sponsor_note_id: id.optional(),
      sponsor_version_id: id.optional(),
      sponsor_admission_generation: z.number().int().positive().optional(),
    })
    .strict(),
  CommitOpSchema.options[1].strict(),
  CommitOpSchema.options[2].strict(),
  CommitOpSchema.options[3].strict(),
  CommitOpSchema.options[4].strict(),
])
export type ScopedCommitOp = z.infer<typeof ScopedCommitOpSchema>
export const ScopedCommitRequestSchema = z
  .object({ request_id: id, ops: z.array(ScopedCommitOpSchema).min(1).max(32) })
  .strict()
export type ScopedCommitRequest = z.infer<typeof ScopedCommitRequestSchema>
export const ScopedCommitResultSchema = z.discriminatedUnion('status', [
  CommitOpResultSchema.options[0].omit({ seq: true }).strict(),
  CommitOpResultSchema.options[1].omit({ seq: true }).strict(),
  CommitOpResultSchema.options[2].omit({ seq: true }).strict(),
  z.object({ status: z.literal('acknowledged'), file_id: id, version_id: id }).strict(),
])
export const ScopedCommitResponseSchema = z
  .object({
    outcome_id: id,
    acknowledged: z.boolean(),
    results: z.array(ScopedCommitResultSchema).max(32),
  })
  .strict()
export type ScopedCommitResponse = z.infer<typeof ScopedCommitResponseSchema>
