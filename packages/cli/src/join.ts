import { joinFinished, type SyncReport } from '@abele/sync-core'
import { readConfig, writeConfig } from './config.js'

/** Clear a retained engine join choice only after its bounded sync completed.
 * Token connect itself always uses the ordinary first-connect conflict rule. */
export function forgetJoinOnceDone(dir: string, report: SyncReport): boolean {
  if (!joinFinished(report)) return false
  const cfg = readConfig(dir)
  if (cfg?.joinPrefer === undefined) return false
  const { joinPrefer: _done, ...rest } = cfg
  writeConfig(dir, rest)
  return true
}
