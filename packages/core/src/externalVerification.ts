import {
  AbeleError,
  requireExternalFilesCapabilities,
  type ExternalVerifyRequest,
  type ExternalVerifyResponse,
} from '@abele/sync-protocol'
import { EngineError } from './errors.js'

/** Only absent/unknown/incomplete support is translated. Offline and authorization
 * errors remain their own failures, and never cause a personal/scoped fallback.
 */
export async function negotiateExternalFiles(
  load: () => Promise<unknown>,
  mode: 'personal' | 'scoped'
) {
  try {
    return requireExternalFilesCapabilities(await load(), mode)
  } catch (error) {
    if (
      (error instanceof AbeleError && error.code === 'not_found') ||
      (error instanceof EngineError && error.code === 'protocol')
    )
      throw new AbeleError(
        'external_files_unavailable',
        'required external-files verification is unavailable'
      )
    throw error
  }
}
export function checkedExternalVerification(
  file: string,
  expected: ExternalVerifyRequest,
  response: ExternalVerifyResponse
) {
  if (
    response.file_id !== file ||
    response.version_id !== expected.version_id ||
    response.path !== expected.path ||
    response.sha !== expected.sha ||
    response.size !== expected.size
  )
    throw new EngineError(
      'protocol',
      'external verification does not match the requested live version'
    )
  return response
}
