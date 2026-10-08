import { z } from 'zod'
import { AbeleError } from './errors.js'
import { PathSchema, ShaSchema } from './schemas.js'

/** Independent extension: the strict personal/scoped capabilities response is unchanged. */
export const EXTERNAL_FILES_VERSION = 1
export const EXTERNAL_FILES_VERSION_HEADER = 'x-abele-external-files-version'
export const EXTERNAL_FILES_MAX_BYTES = 200 * 1024 * 1024
export const ExternalFilesCapabilitiesSchema = z
  .object({
    extension_version: z.literal(EXTERNAL_FILES_VERSION),
    projection_schema: z.literal(1),
    personal: z.boolean(),
    scoped: z.boolean(),
    verification: z
      .object({
        live_head: z.literal(true),
        sha256: z.literal(true),
        actual_size: z.literal(true),
        authorization_rechecked: z.literal(true),
      })
      .strict(),
    max_file_size: z.number().int().positive().max(EXTERNAL_FILES_MAX_BYTES),
  })
  .strict()
export type ExternalFilesCapabilities = z.infer<typeof ExternalFilesCapabilitiesSchema>
export const ExternalVerifyRequestSchema = z
  .object({
    version_id: z.string().min(1),
    path: PathSchema,
    sha: ShaSchema,
    size: z.number().int().nonnegative().max(EXTERNAL_FILES_MAX_BYTES),
  })
  .strict()
export type ExternalVerifyRequest = z.infer<typeof ExternalVerifyRequestSchema>
export const ExternalVerifyResponseSchema = ExternalVerifyRequestSchema.extend({
  verified: z.literal(true),
  file_id: z.string().min(1),
}).strict()
export type ExternalVerifyResponse = z.infer<typeof ExternalVerifyResponseSchema>
export function requireExternalFilesVersion(version: unknown): void {
  if (version !== String(EXTERNAL_FILES_VERSION))
    throw new AbeleError('invalid_request', 'external-files extension version 1 is required')
}
/** Unknown/incomplete support never authorizes an eviction. No scoped-to-personal fallback. */
export function requireExternalFilesCapabilities(
  response: unknown,
  mode: 'personal' | 'scoped'
): ExternalFilesCapabilities {
  const parsed = ExternalFilesCapabilitiesSchema.safeParse(response)
  if (!parsed.success || !parsed.data[mode])
    throw new AbeleError(
      'external_files_unavailable',
      'required external-files verification is unavailable'
    )
  return parsed.data
}
