import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeRetentionSnapshot } from '@abele/sync-core'

/** Retirement accepts only the explicit local owner handover. Unknown artifacts
 * still block; this is not an exemption for everything under the directory. */
export function retentionHandedOver(directory: string): boolean {
  try {
    const summary = join(directory, 'summary.json')
    if (!existsSync(summary) || !lstatSync(summary).isFile() || lstatSync(summary).isSymbolicLink())
      return false
    const rows = decodeRetentionSnapshot(JSON.parse(readFileSync(summary, 'utf8')))
    if (
      rows.some(
        (row) =>
          row.phase !== 'committed' || row.decision !== undefined || row.publication !== undefined
      )
    )
      return false
    const ids = new Set(rows.map((row) => row.id))
    return readdirSync(directory).every((name) => {
      if (name === 'summary.json') return true
      if (name === 'legacy-migrated') {
        const marker = join(directory, name),
          info = lstatSync(marker)
        return info.isFile() && !info.isSymbolicLink() && readFileSync(marker, 'utf8') === '1'
      }
      const folder = join(directory, name),
        info = lstatSync(folder)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
      const names = readdirSync(folder)
      if (!names.length) return true
      if (!ids.has(name) || names.length !== 1 || names[0] !== 'victim') return false
      const victim = lstatSync(join(folder, 'victim'))
      return victim.isFile() && !victim.isSymbolicLink()
    })
  } catch {
    return false
  }
}
