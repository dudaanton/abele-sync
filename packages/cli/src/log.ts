import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureStateFolder } from './config.js'

export interface Log {
  /** One ISO-timestamped line. */
  line(text: string): void
}

/**
 * The vault's log, at `<dir>/.abele-sync/log`.
 *
 * Every line is appended and the file is not held open, so several openers — the daemon and a
 * one-off command — write to one log without either losing the other's lines. A log that cannot
 * be written is not worth failing a sync over, so `line` swallows what it cannot do.
 */
export function openLog(dir: string): Log {
  const file = join(ensureStateFolder(dir), 'log')
  return {
    line(text: string): void {
      try {
        appendFileSync(file, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 })
      } catch {
        /* the log is a courtesy, never a reason to stop syncing */
      }
    },
  }
}
