import { z } from 'zod'
import { PrincipalIdSchema } from './principals.js'
import { FolderPrefixSchema, ScopedRoleSchema } from './scopedV4.js'

const label = z.string().trim().min(1).max(200)
const expiry = z.string().datetime({ offset: true })
const revision = z.number().int().nonnegative().safe()
export const CreateFolderGrantRequestSchema = z
  .object({
    label,
    prefix: FolderPrefixSchema,
    role: ScopedRoleSchema,
    expires_at: expiry.nullable().optional(),
  })
  .strict()
export const UpdateFolderGrantRequestSchema = z
  .object({
    expected_revision: revision,
    label: label.optional(),
    prefix: FolderPrefixSchema.optional(),
    role: ScopedRoleSchema.optional(),
    expires_at: expiry.nullable().optional(),
    revoke: z.boolean().optional(),
    /** Explicit reviewed reset of an expired/uncertain preparation. */
    rebuild: z.boolean().optional(),
  })
  .strict()
export const IssueFolderKeyRequestSchema = z
  .object({
    attempt_id: PrincipalIdSchema,
    name: label,
    role: ScopedRoleSchema,
    expires_at: expiry,
  })
  .strict()
export const UpdateFolderKeyRequestSchema = z
  .object({
    expected_revision: revision,
    name: label.optional(),
    role: ScopedRoleSchema.optional(),
    expires_at: expiry.optional(),
    revoke: z.boolean().optional(),
  })
  .strict()
export type CreateFolderGrantRequest = z.infer<typeof CreateFolderGrantRequestSchema>
export type UpdateFolderGrantRequest = z.infer<typeof UpdateFolderGrantRequestSchema>
export type IssueFolderKeyRequest = z.infer<typeof IssueFolderKeyRequestSchema>
export type UpdateFolderKeyRequest = z.infer<typeof UpdateFolderKeyRequestSchema>
