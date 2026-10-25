import { AbeleError } from '@abele/sync-protocol'

/** Restrict restart to the manifest continuation refusal, including older servers. */
export function expiredManifestCursor(error: unknown): boolean {
  return (
    error instanceof AbeleError &&
    error.code === 'invalid_request' &&
    error.message === 'invalid or expired page cursor'
  )
}
