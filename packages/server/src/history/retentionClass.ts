import type { FileKind } from '@abele/sync-protocol'
import type { RetentionClass } from '../db/schema.js'

/** Stamp the policy class once, when writing a version. Scripts retain the attachment window. */
export function retentionClass(kind: FileKind): RetentionClass {
  if (kind === 'note' || kind === 'canvas') return 'notes'
  if (kind === 'settings') return 'settings'
  return 'attachments'
}
