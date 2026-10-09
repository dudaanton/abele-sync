import { describe, expect, it } from 'vitest'
import * as Core from '../../src/index.js'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Scoped hosts own their FIFO queue; the public core facade must use that very queue. */
function scopedHost() {
  let tail: Promise<unknown> = Promise.resolve(),
    closed = false
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => {
      if (closed) throw new Error('scoped host closed')
      return work()
    })
    tail = result.catch(() => {})
    return result
  }
  return {
    serial,
    operations: Core.exclusiveOperationPort(serial),
    close: async () => {
      closed = true
      await tail
    },
  }
}

describe('public port over a scoped host scheduler', () => {
  it('preserves FIFO ordering with pull/push and retains the queue until an effect settles', async () => {
    const host = scopedHost(),
      entered = gate(),
      release = gate()
    const events: string[] = []
    const pull = host.serial(async () => {
      events.push('pull')
      entered.release()
      await release.promise
    })
    await entered.promise
    const effect = host.operations.runExclusive(async () => {
      events.push('evict')
      return 7
    })
    const push = host.serial(async () => {
      events.push('push')
    })
    try {
      await turn()
      expect(events).toEqual(['pull'])
    } finally {
      release.release()
    }
    await pull
    await expect(effect).resolves.toBe(7)
    await push
    expect(events).toEqual(['pull', 'evict', 'push'])
  })

  it('awaits same-file publication before queue entry rather than deadlocking the scoped queue', async () => {
    const host = scopedHost()
    let version = 'unsynced'
    await host.operations.runExclusive(
      async () => {
        expect(version).toBe('published')
        version = 'evicted'
      },
      {
        before: () =>
          host.serial(async () => {
            version = 'published'
          }),
      }
    )
    expect(version).toBe('evicted')
  })

  it('keeps the scoped queue usable after a throw and preserves its close/cancellation refusal', async () => {
    const host = scopedHost()
    await expect(
      host.operations.runExclusive(() => {
        throw new Error('install failed')
      })
    ).rejects.toThrow('install failed')
    await expect(host.operations.runExclusive(async () => 'next')).resolves.toBe('next')
    const entered = gate(),
      release = gate()
    const running = host.serial(async () => {
      entered.release()
      await release.promise
    })
    await entered.promise
    let ran = false
    const waiting = host.operations.runExclusive(async () => {
      ran = true
    })
    const refused = expect(waiting).rejects.toThrow('scoped host closed')
    const closing = host.close()
    release.release()
    await running
    await refused
    await closing
    expect(ran).toBe(false)
  })

  it('never enters the scheduler after a rejected prerequisite', async () => {
    let scheduled = false
    const port = Core.exclusiveOperationPort(async (job) => {
      scheduled = true
      return job()
    })
    await expect(
      port.runExclusive(async () => 'effect', {
        before: async () => {
          throw new Error('publication failed')
        },
      })
    ).rejects.toThrow('publication failed')
    expect(scheduled).toBe(false)
  })
})
