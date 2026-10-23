/** Macrotask checkpoints: resolved promises alone never let a renderer paint. */
export class ScanWork {
  private count = 0
  private started = performance.now()
  async step() {
    // Bound both batch size and CPU time; avoid reading the clock for every path.
    if (++this.count % 128 !== 0 || performance.now() - this.started < 8) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
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
