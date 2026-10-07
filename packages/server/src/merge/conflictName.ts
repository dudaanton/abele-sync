import { fitGeneratedName } from '@abele/sync-protocol'

/** Characters no file system or Obsidian accepts in a name, plus control characters. */
const FORBIDDEN = /[\\/:*?"<>|#^\[\]\u0000-\u001f\u007f]/g
const MAX_DEVICE_NAME = 40
const FALLBACK_DEVICE = 'device'

/**
 * A device name fit for a file name: whitespace trimmed, forbidden characters replaced with
 * `-`, runs of `-` collapsed to one (edge dashes stay: `[laptop]` → `-laptop-`), at most 40
 * code points, and `device` when nothing is left.
 */
function deviceForName(deviceName: string): string {
  const cleaned = deviceName.trim().replace(FORBIDDEN, '-').replace(/-+/g, '-')
  const truncated = Array.from(cleaned).slice(0, MAX_DEVICE_NAME).join('')
  return truncated === '' ? FALLBACK_DEVICE : truncated
}

/** YYYYMMDDHHMM in UTC. */
const stamp = (at: Date): string => at.toISOString().replace(/[-T:]/g, '').slice(0, 12)

/**
 * The name Obsidian Sync gives a conflicted copy:
 * `Folder/Note.md` → `Folder/Note (Conflicted copy laptop 202609041530).md`.
 */
export function conflictCopyName(path: string, deviceName: string, at: Date): string {
  const slash = path.lastIndexOf('/')
  const folder = path.slice(0, slash + 1)
  const file = path.slice(slash + 1)
  // A dotfile has no extension; its leading dot belongs to the stem.
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  return fitGeneratedName(
    folder,
    stem,
    ext,
    ` (Conflicted copy ${deviceForName(deviceName).normalize('NFC')} ${stamp(at)})`
  )
}
