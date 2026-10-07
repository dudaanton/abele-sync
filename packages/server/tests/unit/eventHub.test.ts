import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventFrame } from '@abele/sync-protocol'
import { EventHub } from '../../src/events/hub.js'

/** A socket the way the hub sees one: something to send strings to, and a close to hear. */
class FakeSocket {
  readonly sent: string[] = []
  private readonly closers: (() => void)[] = []
  broken = false

  send(data: string): void {
    if (this.broken) throw new Error('socket is gone')
    this.sent.push(data)
  }

  on(_event: 'close', cb: () => void): void {
    this.closers.push(cb)
  }

  /** What the peer would do; the hub hears it through the listener it registered. */
  close(): void {
    for (const cb of this.closers) cb()
  }

  frames(): EventFrame[] {
    return this.sent.map((s) => JSON.parse(s) as EventFrame)
  }
}

const seqOnly = (frame: EventFrame): boolean => frame.type === 'seq'
const everything = (): boolean => true

describe('EventHub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces notifications in one window into a single frame carrying the latest seq', () => {
    const hub = new EventHub(250)
    const socket = new FakeSocket()
    hub.attach('v1', socket, seqOnly)

    hub.notify('v1', 1)
    hub.notify('v1', 2)
    vi.advanceTimersByTime(249)
    expect(socket.sent).toEqual([])

    vi.advanceTimersByTime(1)
    expect(socket.frames()).toEqual([{ type: 'seq', head_seq: 2 }])

    hub.notify('v1', 3)
    vi.advanceTimersByTime(250)
    expect(socket.frames()).toEqual([
      { type: 'seq', head_seq: 2 },
      { type: 'seq', head_seq: 3 },
    ])
  })

  it('sends the highest seq of the window even when they arrive out of order', () => {
    const hub = new EventHub(100)
    const socket = new FakeSocket()
    hub.attach('v1', socket, seqOnly)
    hub.notify('v1', 7)
    hub.notify('v1', 4)
    vi.advanceTimersByTime(100)
    expect(socket.frames()).toEqual([{ type: 'seq', head_seq: 7 }])
  })

  it('reaches every socket of the vault and no socket of another', () => {
    const hub = new EventHub(50)
    const a1 = new FakeSocket()
    const a2 = new FakeSocket()
    const b = new FakeSocket()
    hub.attach('a', a1, seqOnly)
    hub.attach('a', a2, seqOnly)
    hub.attach('b', b, seqOnly)
    expect(hub.sockets('a')).toBe(2)
    expect(hub.sockets('b')).toBe(1)

    hub.notify('a', 9)
    vi.advanceTimersByTime(50)
    expect(a1.frames()).toEqual([{ type: 'seq', head_seq: 9 }])
    expect(a2.frames()).toEqual([{ type: 'seq', head_seq: 9 }])
    expect(b.sent).toEqual([])
  })

  it('lets each socket filter say what it will take', () => {
    const hub = new EventHub(10)
    const device = new FakeSocket()
    const listener = new FakeSocket()
    hub.attach('a', device, seqOnly)
    hub.attach('a', listener, everything)

    hub.notifyEpoch('a', 3)
    expect(device.sent).toEqual([])
    expect(listener.frames()).toEqual([{ type: 'scope_epoch', epoch: 3 }])

    hub.notify('a', 1)
    vi.advanceTimersByTime(10)
    expect(device.frames()).toEqual([{ type: 'seq', head_seq: 1 }])
  })

  it('drops a socket whose send fails and never writes to it again', () => {
    const hub = new EventHub(10)
    const good = new FakeSocket()
    const broken = new FakeSocket()
    hub.attach('a', good, seqOnly)
    hub.attach('a', broken, seqOnly)
    broken.broken = true

    hub.notify('a', 1)
    vi.advanceTimersByTime(10)
    expect(hub.sockets('a')).toBe(1)
    expect(good.frames()).toEqual([{ type: 'seq', head_seq: 1 }])

    broken.broken = false
    hub.notify('a', 2)
    vi.advanceTimersByTime(10)
    expect(broken.sent).toEqual([])
    expect(good.frames()).toHaveLength(2)
  })

  it('forgets a socket that closes, and a detach called twice changes nothing', () => {
    const hub = new EventHub(10)
    const socket = new FakeSocket()
    const other = new FakeSocket()
    const detach = hub.attach('a', socket, seqOnly)
    hub.attach('a', other, seqOnly)

    socket.close()
    expect(hub.sockets('a')).toBe(1)
    detach()
    expect(hub.sockets('a')).toBe(1)

    hub.notify('a', 5)
    vi.advanceTimersByTime(10)
    expect(socket.sent).toEqual([])
    expect(other.frames()).toEqual([{ type: 'seq', head_seq: 5 }])
  })

  it('counts nothing for a vault nobody listens on, and sending there throws at no one', () => {
    const hub = new EventHub(10)
    expect(hub.sockets('empty')).toBe(0)
    hub.notify('empty', 1)
    hub.notifyEpoch('empty', 1)
    vi.advanceTimersByTime(10)
    expect(hub.sockets('empty')).toBe(0)
  })

  it('hangs up every socket of a revoked device, and only those', () => {
    const hub = new EventHub(10)
    const stolen = new FakeSocket()
    const stolenElsewhere = new FakeSocket()
    const kept = new FakeSocket()
    const codes: Array<number | undefined> = []
    stolen.close = (code?: number) => void codes.push(code)
    hub.attach('a', stolen, seqOnly, 'dev-stolen')
    hub.attach('b', stolenElsewhere, seqOnly, 'dev-stolen')
    hub.attach('a', kept, seqOnly, 'dev-kept')

    hub.hangUp('dev-stolen', 4001)
    expect(codes).toEqual([4001])
    expect(hub.sockets('a')).toBe(1)
    expect(hub.sockets('b')).toBe(0)

    hub.notify('a', 7)
    vi.advanceTimersByTime(10)
    expect(stolen.sent).toEqual([])
    expect(kept.frames()).toEqual([{ type: 'seq', head_seq: 7 }])
  })
})
