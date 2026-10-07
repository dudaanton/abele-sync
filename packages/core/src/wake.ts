import type { VaultClient } from './client.js'
import { messageOf } from './engineTypes.js'

/**
 * What wakes the engine besides the watcher: the server's event stream, the wait before trying
 * a server again, and the clock for when nothing has spoken in a while. The engine owns whether
 * it runs at all; this owns the socket and the timers, and asks the engine before each of them.
 */

/** How long a socket has to stay open, with no frame, before it counts as connected. */
const SOCKET_GRACE_MS = 5_000

/** A timer as this host hands them out; `unref` where it can, so none keeps a process alive. */
export type Timer = ReturnType<typeof setTimeout>

export function after(ms: number, fn: () => void): Timer {
  const timer = setTimeout(fn, ms)
  ;(timer as unknown as { unref?: () => unknown })?.unref?.()
  return timer
}

/** The engine, as its socket and its timers need it. */
export interface WakeContext {
  client: VaultClient
  log: (line: string) => void
  /** The first and the longest wait before trying a server again. */
  backoffMs: readonly [number, number]
  /** How often to sync with nothing prompting it. */
  fallbackMs: number
  /** Whether anything runs on its own: started, and neither paused nor halted. */
  live: () => boolean
  /** Run a sync, if the engine takes triggers now, and say why. */
  trigger: (why: string) => void
  /** A seq a frame of the event stream carried. */
  onSeq: (seq: number) => void
}

export class Wake {
  private unsubscribe: (() => void) | null = null
  private retry: Timer | null = null
  private reconnect: Timer | null = null
  private grace: Timer | null = null
  private fallback: Timer | null = null
  /** The next wait before trying the server again; doubles on every failure, resets on success. */
  private delay: number
  /**
   * The next wait before opening the socket again: doubles on every open that did not hold,
   * and goes back to the shortest once one has. Its own counter, not the sync's — a server
   * whose HTTP answers and whose socket does not would otherwise reset it on every sync and
   * be asked again every two seconds for ever.
   */
  private reconnectDelay: number
  /** Whether the socket now open has held: a frame arrived, or the grace period passed. */
  private socketHeld = false
  /** Set by a close: the next socket to hold syncs once, for the frames that were missed. */
  private reconnecting = false

  constructor(private readonly ctx: WakeContext) {
    this.delay = ctx.backoffMs[0]
    this.reconnectDelay = ctx.backoffMs[0]
  }

  /** A sync got through: the next failure waits the shortest time again. */
  succeeded(): void {
    this.delay = this.ctx.backoffMs[0]
  }

  /* ── The event stream ────────────────────────────────────────────────── */

  connect(): void {
    if (!this.ctx.live() || this.unsubscribe !== null) return
    this.socketHeld = false
    try {
      this.unsubscribe = this.ctx.client.subscribe(
        (seq) => {
          this.held(true)
          this.ctx.onSeq(seq)
        },
        (why) => {
          this.unsubscribe = null
          this.clearGrace()
          this.ctx.log(`events: ${why}`)
          this.reconnectLater()
        }
      )
    } catch (error) {
      // A host with no socket to open: the clock is what there is.
      this.ctx.log(`events: ${messageOf(error)}`)
      return
    }
    // `subscribe` says nothing about opening; a socket that has stayed up this long is up.
    this.grace = after(SOCKET_GRACE_MS, () => {
      this.grace = null
      this.held(false)
    })
  }

  /**
   * The socket has held. The wait before the next open goes back to its shortest, and a
   * socket brought back after a close syncs once for the frames that were missed — unless
   * what said it held was a frame, which speaks for itself.
   */
  private held(byFrame: boolean): void {
    this.clearGrace()
    if (this.socketHeld) return
    this.socketHeld = true
    this.reconnectDelay = this.ctx.backoffMs[0]
    if (!this.reconnecting) return
    this.reconnecting = false
    if (!byFrame) this.ctx.trigger('reconnect')
  }

  disconnect(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.clearGrace()
    this.reconnecting = false
  }

  private clearGrace(): void {
    if (this.grace !== null) clearTimeout(this.grace)
    this.grace = null
  }

  /* ── Timers ──────────────────────────────────────────────────────────── */

  /** The current wait, and double it for next time, up to the longest allowed. */
  private nextDelay(): number {
    const ms = this.delay
    this.delay = Math.min(ms * 2, this.ctx.backoffMs[1])
    return ms
  }

  retryLater(): void {
    if (!this.ctx.live() || this.retry !== null) return
    this.retry = after(this.nextDelay(), () => {
      this.retry = null
      this.ctx.trigger('retry')
    })
  }

  /** Open the socket again after a wait, and nothing more: `held` says when it is back. */
  private reconnectLater(): void {
    if (!this.ctx.live() || this.reconnect !== null) return
    this.reconnecting = true
    const ms = this.reconnectDelay
    this.reconnectDelay = Math.min(ms * 2, this.ctx.backoffMs[1])
    this.reconnect = after(ms, () => {
      this.reconnect = null
      this.connect()
    })
  }

  scheduleFallback(): void {
    if (this.fallback !== null) clearTimeout(this.fallback)
    this.fallback = null
    if (!this.ctx.live()) return
    this.fallback = after(this.ctx.fallbackMs, () => {
      this.fallback = null
      this.ctx.trigger('fallback')
      this.scheduleFallback()
    })
  }

  clearTimers(): void {
    for (const timer of [this.retry, this.reconnect, this.fallback]) {
      if (timer !== null) clearTimeout(timer)
    }
    this.retry = null
    this.reconnect = null
    this.fallback = null
    this.clearGrace()
  }
}
