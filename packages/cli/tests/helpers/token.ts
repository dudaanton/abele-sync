import { encodeAccessToken, type V2Connection } from '@abele/sync-protocol'

/** Synthetic bearer token; intentionally not an account/device credential. */
export function tokenFor(address: string, key = 'a'.repeat(43)): string {
  return encodeAccessToken({ v: 1, address, key, scope: { kind: 'folder', id: 'root', path: '/' } })
}
export const connection: V2Connection = {
  protocol: 2,
  token_id: 'd1',
  space_id: 'v1',
  scope: { kind: 'folder', id: 'root', path: '/' },
  status: 'active',
  limits: { max_file_bytes: 200 * 1024 * 1024, quota_bytes: null },
}
