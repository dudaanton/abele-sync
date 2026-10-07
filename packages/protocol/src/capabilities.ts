import { z } from 'zod'
import { AbeleError } from './errors.js'

/** Product v4 has a distinct scoped wire version; the personal protocol remains v1. */
export const SCOPED_PROTOCOL_VERSION = 4
export const SCOPED_VERSION_HEADER = 'x-abele-scoped-version'
export const SCOPED_REQUIRED_CAPABILITIES = [
  'common_read_profile',
  'version_filtered_history',
  'materialized_snapshots',
  'grant_local_feed',
  'authorized_merge',
  'sponsored_extras',
  'native_creates',
  'script_policy',
  'settings_exclusion',
] as const

/** Initial negotiated ceilings, not measured capacity or substitutes for runtime accounting. */
export const SCOPED_LIMITS = Object.freeze({
  max_live_grants: 64,
  max_operations: 32,
  max_prepared_note_bytes: 8 * 1024 * 1024,
  max_page_items: 1000,
  max_snapshots: 2,
  snapshot_lifetime_seconds: 300,
})
const limit = (max: number) => z.number().int().positive().max(max)
export const ScopedLimitsSchema = z
  .object({
    max_live_grants: limit(SCOPED_LIMITS.max_live_grants),
    max_operations: limit(SCOPED_LIMITS.max_operations),
    max_prepared_note_bytes: limit(SCOPED_LIMITS.max_prepared_note_bytes),
    max_page_items: limit(SCOPED_LIMITS.max_page_items),
    max_snapshots: limit(SCOPED_LIMITS.max_snapshots),
    snapshot_lifetime_seconds: limit(SCOPED_LIMITS.snapshot_lifetime_seconds),
  })
  .strict()
export type ScopedLimits = z.infer<typeof ScopedLimitsSchema>
const features = Object.fromEntries(
  SCOPED_REQUIRED_CAPABILITIES.map((name) => [name, z.literal(true)])
) as Record<(typeof SCOPED_REQUIRED_CAPABILITIES)[number], z.ZodLiteral<true>>
export const ScopedCapabilitiesSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      protocol_version: z.literal(SCOPED_PROTOCOL_VERSION),
      modes: z.object({ folder: z.literal(true), group: z.boolean() }).strict(),
      features: z.object(features).strict(),
      limits: ScopedLimitsSchema,
    })
    .strict(),
])
export type ScopedCapabilities = z.infer<typeof ScopedCapabilitiesSchema>
export const CapabilitiesResponseSchema = z
  .object({
    protocol_version: z.literal(1),
    device: z.literal(true),
    scoped: ScopedCapabilitiesSchema,
  })
  .strict()
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>

/** No unknown/partial/old contract or scoped-to-personal fallback. */
export function requireScopedCapabilities(
  response: unknown
): Extract<ScopedCapabilities, { enabled: true }> {
  const parsed = CapabilitiesResponseSchema.safeParse(response)
  if (!parsed.success || !parsed.data.scoped.enabled) {
    throw new AbeleError('scoped_unavailable', 'required v4 scoped capabilities are unavailable')
  }
  return parsed.data.scoped
}

export function requireScopedVersion(version: unknown): void {
  if (version !== String(SCOPED_PROTOCOL_VERSION)) {
    throw new AbeleError('unsupported_scoped_protocol', 'scoped protocol version 4 is required')
  }
}
