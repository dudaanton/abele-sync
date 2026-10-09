/** Preparation that needs ordinary sync must finish before taking the scheduler. */
export interface ExclusiveOperationOptions {
  /**
   * Awaited outside the exclusive queue, e.g. `() => engine.sync()` to publish an
   * unsynced edit before eviction. A rejection prevents queue entry. This is not
   * an atomic precondition: re-read identities, versions and ownership in `work`.
   */
  before?: () => Promise<unknown>
}

/**
 * Whole-engine exclusion for host effects such as attachment eviction/hydration.
 * All pull/scan/push, deferred apply/keep and Restore work must share this queue.
 * This is a runtime scheduler port, not a durable filesystem reservation or a
 * lock against independent writers. Hosts still fence/journal their own effects.
 */
export interface ExclusiveOperationPort {
  /**
   * Run `work` using the engine's existing exclusive scheduler; return its result
   * or rejection. Queue ordering, fairness and cancellation belong to that
   * scheduler, not to this facade. It must retain exclusion until `work` settles,
   * including after cancellation: already-issued host effects cannot be abandoned.
   *
   * Do not await public sync/Restore/deferred verbs or another exclusive operation
   * inside `work`: they need this same queue. Use `before` for publication, then
   * revalidate the same file inside `work`. Neither phase is retried by this port.
   */
  runExclusive<T>(work: () => Promise<T>, options?: ExclusiveOperationOptions): Promise<T>
}

/** The host's actual scheduler, not a second mutex beside its sync queue. */
export type ExclusiveOperationScheduler = <T>(work: () => Promise<T>) => Promise<T>

/**
 * Expose the same public port from a host-owned scheduler (notably scoped hosts:
 * core supplies scoped pull/push functions, while the host owns their queue).
 * Forward to that queue with its existing readiness/closure/cancellation checks.
 * This adapter creates no queue and changes no scheduling policy.
 */
export function exclusiveOperationPort(
  schedule: ExclusiveOperationScheduler
): ExclusiveOperationPort {
  return {
    async runExclusive<T>(work: () => Promise<T>, options?: ExclusiveOperationOptions): Promise<T> {
      if (options?.before !== undefined) await options.before()
      return schedule(work)
    },
  }
}
