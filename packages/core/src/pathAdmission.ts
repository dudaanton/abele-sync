import type { FileSystem } from './fs.js'
import { AbeleError } from '@abele/sync-protocol'

export const pathAdmission: unique symbol = Symbol.for('abele.sync.path-admission-v1')
export type PathAdmission = { allowed: true } | { allowed: false; reason: string }
export class HostPathAdmissionError extends AbeleError {
  constructor(reason: string) {
    super('invalid_path', reason)
  }
}

/** Synchronous metadata-only policy, evaluated before acquiring content or placing a name. */
export function hostPathRefusal(fs: FileSystem, path: string) {
  const admission = fs[pathAdmission]?.(path)
  return admission?.allowed === false
    ? { code: 'invalid_path' as const, message: admission.reason }
    : undefined
}

export function assertHostPath(fs: FileSystem, path: string): void {
  const refusal = hostPathRefusal(fs, path)
  if (refusal) throw new HostPathAdmissionError(refusal.message)
}
