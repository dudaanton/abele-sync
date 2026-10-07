import { z } from 'zod'
import type { BlobStore } from '../blobs/store.js'
import { AbeleError } from '@abele/sync-protocol'

const CursorSchema = z
  .object({
    kind: z.literal('page'),
    snapshot_id: z.string().min(1).max(200),
    vault_id: z.string().min(1).max(200),
    grant_id: z.string().min(1).max(200),
    principal_kind: z.enum(['key', 'installation']),
    principal_id: z.string().min(1).max(200),
    authority: z.string().regex(/^[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative().max(100000),
    limit: z.number().int().min(1).max(1000),
    checkpoint: z.string().min(1).max(2048),
  })
  .strict()
export type SnapshotCursor = z.infer<typeof CursorSchema>
export interface CursorStore {
  store: Pick<BlobStore, 'sealPart' | 'openPart'>
  endpointIdentity?: string
  config?: { publicUrl?: string }
}
const label = (deps: CursorStore) =>
  `v4-folder-snapshot:${deps.endpointIdentity ?? deps.config?.publicUrl ?? 'local'}`
export const unavailable = () =>
  new AbeleError('scope_unavailable', 'snapshot unavailable; restart the complete view')
export function encodeSnapshotCursor(deps: CursorStore, value: SnapshotCursor): string {
  return deps.store.sealPart(Buffer.from(JSON.stringify(value)), label(deps)).toString('base64url')
}
export function decodeSnapshotCursor(deps: CursorStore, token: string): SnapshotCursor {
  if (!token || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw unavailable()
  try {
    const bytes = Buffer.from(token, 'base64url')
    if (bytes.toString('base64url') !== token) throw unavailable()
    const opened = deps.store.openPart(bytes, label(deps))
    if (!opened || opened.byteLength > 2048) throw unavailable()
    return CursorSchema.parse(JSON.parse(opened.toString('utf8')))
  } catch {
    throw unavailable()
  }
}
export function snapshotCheckpoint(
  deps: CursorStore,
  id: string,
  authority: string,
  generation: number,
  position: number
) {
  return {
    kind: 'scoped' as const,
    token: deps.store
      .sealPart(
        Buffer.from(
          JSON.stringify({ kind: 'checkpoint', snapshot_id: id, authority, generation, position })
        ),
        `${label(deps)}:checkpoint`
      )
      .toString('base64url'),
  }
}
