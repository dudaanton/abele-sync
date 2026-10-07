import { z } from 'zod'
import { AbeleError, ScopedCheckpointSchema, type ScopedCheckpoint } from '@abele/sync-protocol'
import type { ScopedAuthority } from './authority.js'
import type { CursorStore } from './snapshotCursor.js'

const Payload = z
  .object({
    kind: z.literal('feed'),
    vault_id: z.string().min(1).max(200),
    grant_id: z.string().min(1).max(200),
    principal_kind: z.enum(['key', 'installation']),
    principal_id: z.string().min(1).max(200),
    continuity: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.number().int().nonnegative().safe(),
    position: z.number().int().nonnegative().safe(),
    known_through: z.number().int().nonnegative().safe(),
    snapshot_pending: z.literal(true).optional(),
  })
  .strict()
export type FeedProgress = z.infer<typeof Payload>
const label = (deps: CursorStore) =>
  `v4-folder-feed:${deps.endpointIdentity ?? deps.config?.publicUrl ?? 'local'}`
export const restartFeed = () =>
  new AbeleError('scope_unavailable', 'feed unavailable; collect a new complete snapshot')
export function encodeFeedProgress(
  deps: CursorStore,
  a: ScopedAuthority,
  generation: number,
  position: number,
  knownThrough: number,
  snapshotPending = false
): ScopedCheckpoint {
  const value: FeedProgress = {
    kind: 'feed',
    vault_id: a.principal.vault_id,
    grant_id: a.principal.grant_id,
    principal_kind: a.principal.kind,
    principal_id: a.principal.principal_id,
    continuity: a.continuityDigest,
    generation,
    position,
    known_through: knownThrough,
    ...(snapshotPending ? { snapshot_pending: true as const } : {}),
  }
  return {
    kind: 'scoped',
    token: deps.store
      .sealPart(Buffer.from(JSON.stringify(value)), label(deps))
      .toString('base64url'),
  }
}
export function decodeFeedProgress(
  deps: CursorStore,
  a: ScopedAuthority,
  checkpoint: unknown
): FeedProgress {
  try {
    const { token } = ScopedCheckpointSchema.parse(checkpoint)
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw restartFeed()
    const bytes = Buffer.from(token, 'base64url')
    if (bytes.toString('base64url') !== token) throw restartFeed()
    const opened = deps.store.openPart(bytes, label(deps))
    if (!opened || opened.length > 2048) throw restartFeed()
    const value = Payload.parse(JSON.parse(opened.toString('utf8')))
    if (
      value.vault_id !== a.principal.vault_id ||
      value.grant_id !== a.principal.grant_id ||
      value.principal_kind !== a.principal.kind ||
      value.principal_id !== a.principal.principal_id ||
      value.continuity !== a.continuityDigest ||
      value.known_through > value.position ||
      value.snapshot_pending === true
    )
      throw restartFeed()
    return value
  } catch {
    throw restartFeed()
  }
}
