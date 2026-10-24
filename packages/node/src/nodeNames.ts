import { statfsSync } from 'node:fs'
import { platform } from 'node:os'
import type { PathAdmission } from '@abele/sync-core'

/** Win32 interprets these names before ordinary filesystem access. Linux FAT
 * mounts share character/alias restrictions, but not Windows device lookup. */
export function nodeNames(root: string) {
  const windows = platform() === 'win32'
  let dosNames = windows
  if (platform() === 'linux') {
    try {
      dosNames = [0x4d44, 0x2011bab0].includes(Number(statfsSync(root).type))
    } catch {
      /* A missing root is handled by the ordinary filesystem boundary. */
    }
  }
  return {
    canonical: (path: string) =>
      dosNames
        ? path
            .split('/')
            .map((part) => part.replace(/[ .]+$/g, ''))
            .join('/')
        : path,
    admit: (path: string): PathAdmission => {
      for (const part of path.split('/')) {
        if (dosNames && (/[<>:"|?*\\\u0000-\u001f]/.test(part) || /[ .]$/.test(part)))
          return {
            allowed: false,
            reason: 'unsupported-host-name: character or trailing dot/space',
          }
        const stem = part.split('.')[0]!.replace(/[ .]+$/g, '')
        if (windows && /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i.test(stem))
          return { allowed: false, reason: 'unsupported-host-name: reserved Windows device name' }
      }
      return { allowed: true }
    },
  }
}
