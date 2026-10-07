import type { EventFrame } from '@abele/sync-protocol'

/** The little of a socket the hub needs: somewhere to write, word when it goes, and a hang-up. */
export interface EventSocket {
  send(data: string): void
  on(event: 'close', cb: () => void): void
  close(code?: number): void
}

/** Which frames a socket has any business hearing. */
export type EventFilter = (frame: EventFrame) => boolean

/** One attached socket and the frames it takes. */
interface Listener {
  socket: EventSocket
  filter: EventFilter
  /** The device whose token opened it, so revoking the device can hang it up; null for none. */
  deviceId: string | null
}

/**
 * Where a committed sequence is announced to the devices listening on a vault.
 *
 * A commit says `notify`; the hub waits out a short window and then sends one
 * frame carrying the sequence the vault ended on, however many commits landed
 * meanwhile. A device that hears it asks for the changes itself, so a coalesced
 * frame costs it nothing and a burst of writes never turns into a burst of
 * sockets waking up.
 */
export class EventHub {
  readonly #listeners = new Map<string, Set<Listener>>()
  /** Vaults with a window open, each holding the highest seq seen in it. */
  readonly #pending = new Map<string, number>()
  readonly #debounceMs: number

  constructor(debounceMs = 250) {
    this.#debounceMs = debounceMs
  }

  /**
   * Listen on a vault, for the device named. The returned function detaches, and so does the
   * socket closing.
   */
  attach(
    vaultId: string,
    socket: EventSocket,
    filter: EventFilter,
    deviceId: string | null = null
  ): () => void {
    const listener: Listener = { socket, filter, deviceId }
    let listeners = this.#listeners.get(vaultId)
    if (listeners === undefined) {
      listeners = new Set()
      this.#listeners.set(vaultId, listeners)
    }
    listeners.add(listener)

    const detach = (): void => {
      this.#detach(vaultId, listener)
    }
    socket.on('close', detach)
    return detach
  }

  /** A vault has moved to `headSeq`. One frame per window, carrying the latest one. */
  notify(vaultId: string, headSeq: number): void {
    const open = this.#pending.get(vaultId)
    if (open !== undefined) {
      // A window already runs: it keeps its place, and only the sequence moves on.
      if (headSeq > open) this.#pending.set(vaultId, headSeq)
      return
    }
    this.#pending.set(vaultId, headSeq)

    const timer = setTimeout(() => {
      const seq = this.#pending.get(vaultId)
      this.#pending.delete(vaultId)
      if (seq !== undefined) this.#send(vaultId, { type: 'seq', head_seq: seq })
    }, this.#debounceMs)
    // The announcement is never the reason a process stays up.
    timer.unref?.()
  }

  /** A vault's scope epoch has moved. Each socket's filter decides whether it hears it. */
  notifyEpoch(vaultId: string, epoch: number): void {
    this.#send(vaultId, { type: 'scope_epoch', epoch })
  }

  /**
   * Hang up every socket a device opened, on any vault, with `code`: the device was revoked, and
   * a socket it already holds must not go on hearing when the vault moves. Each is detached first, so nothing more is sent to it whatever the close does.
   */
  hangUp(deviceId: string, code: number): void {
    for (const [vaultId, listeners] of [...this.#listeners]) {
      for (const listener of [...listeners]) {
        if (listener.deviceId !== deviceId) continue
        this.#detach(vaultId, listener)
        try {
          listener.socket.close(code)
        } catch {
          // Gone already: detached is all that was needed.
        }
      }
    }
  }

  /** How many sockets listen on a vault. */
  sockets(vaultId: string): number {
    return this.#listeners.get(vaultId)?.size ?? 0
  }

  #send(vaultId: string, frame: EventFrame): void {
    const listeners = this.#listeners.get(vaultId)
    if (listeners === undefined) return
    const data = JSON.stringify(frame)
    // A copy: a send that fails detaches its socket, and that edits the set.
    for (const listener of [...listeners]) {
      if (!listener.filter(frame)) continue
      try {
        listener.socket.send(data)
      } catch {
        // A socket that cannot be written to is gone, whatever it says of itself.
        this.#detach(vaultId, listener)
      }
    }
  }

  #detach(vaultId: string, listener: Listener): void {
    const listeners = this.#listeners.get(vaultId)
    if (listeners === undefined) return
    listeners.delete(listener)
    // Nothing of a vault nobody listens on is kept.
    if (listeners.size === 0) this.#listeners.delete(vaultId)
  }
}
