import { checkCancellation } from './cancellation.js'

export interface ScanScheduling {
  /** Yield a host task (not merely a resolved promise). Defaults to a posted message. */
  yieldTask?: () => Promise<void>
  signal?: AbortSignal
}

/** Message tasks avoid the browser's nested-timer clamp. Close both ports after
 * delivery: an idle SDK must not keep a renderer/Node process alive. */
function hostTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** Macrotask checkpoints: resolved promises alone never let a renderer paint. */
export class ScanWork {
  private count = 0
  private started = performance.now()
  constructor(private readonly opts: ScanScheduling = {}) {}
  async step() {
    checkCancellation(this.opts.signal)
    if (++this.count < 256 && performance.now() - this.started < 8) return
    await (this.opts.yieldTask?.() ?? hostTask())
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
