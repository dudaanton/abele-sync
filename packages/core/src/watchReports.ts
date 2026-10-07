import { normalisePath } from '@abele/sync-protocol'
import type { ExpectedWrites } from './echo.js'
import type { FileSystem } from './fs.js'
import { sha256 } from './hash.js'
import { after, type Timer } from './wake.js'

/**
 * What the host's file watcher said, as the engine keeps it: the paths reported and not looked
 * at yet, collected over a debounce, and the wire paths with a local change no scan has taken
 * in. The engine's own writes come back as echoes and are forgotten here.
 */

/** The engine, as the watcher's reports need it. */
export interface WatchContext {
  fs: FileSystem
  expected: ExpectedWrites
  /** How long the watcher's reports are collected before they are looked at. */
  debounceMs: number
  /** Told once a batch of reports held a local change. */
  onChange: () => void
}

export class WatchReports {
  /** On-disk paths the watcher reported and nobody has looked at yet. */
  private readonly noticed = new Set<string>()
  /** Wire paths with a local change the watcher saw and no scan has taken in yet. */
  readonly reported = new Set<string>()
  private debounce: Timer | null = null

  constructor(private readonly ctx: WatchContext) {}

  notice(paths: string[]): void {
    for (const path of paths) this.noticed.add(path)
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.debounce = after(this.ctx.debounceMs, () => {
      this.debounce = null
      void this.examine().then((changed) => {
        if (changed) this.ctx.onChange()
      })
    })
  }

  /** Drop the debounce that is waiting, if one is. */
  cancel(): void {
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.debounce = null
  }

  /**
   * Look at what the watcher reported. A file whose bytes are a write the engine announced
   * is the engine's own echo and is forgotten; anything else is a local change, remembered
   * for the next pull to keep clear of and the next scan to take in.
   */
  async examine(): Promise<boolean> {
    if (this.debounce !== null) clearTimeout(this.debounce)
    this.debounce = null
    const paths = [...this.noticed]
    this.noticed.clear()
    let changed = false
    for (const path of paths) {
      if (this.ctx.expected.has(path)) {
        const sha = await this.shaOf(path)
        if (sha !== null && this.ctx.expected.consume(path, sha)) continue
      }
      this.reported.add(wireOf(path))
      changed = true
    }
    return changed
  }

  /** What the file at `path` hashes to right now, or null when there is no file to hash. */
  private async shaOf(path: string): Promise<string | null> {
    try {
      if ((await this.ctx.fs.stat(path)) === null) return null
      return await sha256(await this.ctx.fs.read(path))
    } catch {
      return null
    }
  }
}

/** The wire spelling of a path the watcher reported; its own when it has none. */
function wireOf(path: string): string {
  try {
    return normalisePath(path)
  } catch {
    return path
  }
}
