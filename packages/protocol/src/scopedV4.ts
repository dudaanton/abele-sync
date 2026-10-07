import { z } from 'zod'
import { normalisePath, validatePath } from './paths.js'
import { PrincipalIdSchema } from './principals.js'

/** Scoped progress is opaque and grant-local, never a personal numeric vault sequence. */
export const ScopedCheckpointSchema = z
  .object({
    kind: z.literal('scoped'),
    token: z.string().min(1).max(4096),
  })
  .strict()
  .readonly()
export type ScopedCheckpoint = z.infer<typeof ScopedCheckpointSchema>

export const FolderPrefixSchema = z
  .string()
  .min(2)
  .max(1024)
  .refine((prefix) => {
    if (!prefix.endsWith('/')) return false
    const path = prefix.slice(0, -1)
    try {
      validatePath(path)
      if (normalisePath(path) !== path) return false
      // Registered alternative config directories are additionally checked by runtime authority.
      return !['.obsidian', '.trash', '.abele-sync'].includes(path.split('/')[0]!.toLowerCase())
    } catch {
      return false
    }
  }, 'a canonical, non-reserved folder prefix ending in / is required')

/** Exactly one selector; no full-vault, glob, local mount path or prefix stripping. */
export const ScopedGrantSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), prefix: FolderPrefixSchema }).strict(),
  z.object({ kind: z.literal('group'), root_file_id: PrincipalIdSchema }).strict(),
])
export type ScopedGrantSelector = z.infer<typeof ScopedGrantSelectorSchema>
export const ScopedRoleSchema = z.enum(['reader', 'editor'])
export type ScopedRole = z.infer<typeof ScopedRoleSchema>
