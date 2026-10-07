import { createHash } from 'node:crypto'
import type { DaemonConfig } from './config.js'
import type { SqliteStateStore } from './sqliteState.js'

const KEY = 'revoked-binding'

/** Bound to this credential, never a token in the ledger or a flag inherited by
 * a new enrolment. A status snapshot reads it without contacting the server.
 */
export function wasRevoked(state: SqliteStateStore, binding: string): boolean {
  return state.getMeta(KEY) === binding
}
export function recordRevoked(state: SqliteStateStore, binding: string): boolean {
  try {
    state.setMeta(KEY, binding)
    return true
  } catch {
    // A disk failure must not turn terminal revocation back into a retry loop.
    return false
  }
}
export function personalRevocationBinding(cfg: DaemonConfig): string {
  return JSON.stringify([
    cfg.serverUrl,
    cfg.vaultId,
    cfg.deviceId,
    createHash('sha256').update(cfg.deviceToken).digest('hex'),
  ])
}
