import { messageOf } from './engineTypes.js'

/** Paths use the protocol's normalized wire spelling. */
export interface AppliedChange {
  path: string
  kind: 'upsert' | 'delete' | 'move'
  from?: string
  origin: 'remote' | 'local'
  fileId?: string
}

export interface AppliedOptions {
  onApplied?: (change: AppliedChange) => void | Promise<void>
  log?: (message: string) => void
}

/** Host failures must never turn a committed change into a failed sync. */
export async function notifyApplied(opts: AppliedOptions, change: AppliedChange): Promise<void> {
  try {
    await opts.onApplied?.(change)
  } catch (error) {
    try {
      opts.log?.(`onApplied hook failed: ${messageOf(error)}`)
    } catch {
      // Logging a host failure must not make an applied change fail either.
    }
  }
}
