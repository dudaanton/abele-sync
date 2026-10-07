/**
 * Echo suppression: the writes the engine is about to make itself.
 *
 * A pull writes a file, the host's watcher reports that write, and without this registry the
 * engine would push its own change straight back. `expect` before writing, `consume` when the
 * watcher fires — one `consume` per `expect`, so a genuine edit that happens to land on the
 * same bytes is still seen the second time.
 */
export class ExpectedWrites {
  /** path → sha → how many writes of those bytes are still expected. */
  private readonly pending = new Map<string, Map<string, number>>()

  expect(path: string, sha: string): void {
    let shas = this.pending.get(path)
    if (!shas) this.pending.set(path, (shas = new Map()))
    shas.set(sha, (shas.get(sha) ?? 0) + 1)
  }

  /** True once per `expect` of the same path and sha; false for anything else. */
  consume(path: string, sha: string): boolean {
    const shas = this.pending.get(path)
    const count = shas?.get(sha) ?? 0
    if (!shas || count === 0) return false
    if (count === 1) {
      shas.delete(sha)
      if (shas.size === 0) this.pending.delete(path)
    } else {
      shas.set(sha, count - 1)
    }
    return true
  }

  /** Whether any write is still expected at a path, so a watcher need not hash what nobody announced. */
  has(path: string): boolean {
    return this.pending.has(path)
  }

  /** Forgets every expectation at a path — the write failed, or the file went away. */
  clear(path: string): void {
    this.pending.delete(path)
  }
}
