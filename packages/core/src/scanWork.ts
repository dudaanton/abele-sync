import { checkCancellation } from './cancellation.js'

export interface ScanScheduling {
  /** Yield a host task (not merely a resolved promise). Defaults to setTimeout(0). */
  yieldTask?: () => Promise<void>
  signal?: AbortSignal
}

/** Macrotask checkpoints: resolved promises alone never let a renderer paint. */
export class ScanWork {
  private count = 0
  private started = performance.now()
  constructor(private readonly opts: ScanScheduling = {}) {}
  async step() {
    checkCancellation(this.opts.signal)
    if (++this.count < 256 && performance.now() - this.started < 8) return
    await (this.opts.yieldTask?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)))
    checkCancellation(this.opts.signal)
    this.count = 0
    this.started = performance.now()
  }
}

/** One visit per ancestor (linear in the number of path components). */
export function* parents(path: string): Generator<string> {
  for (let end = path.lastIndexOf('/'); end >= 0; end = path.lastIndexOf('/', end - 1)) {
    yield path.slice(0, end)
    if (end === 0) break
  }
}
