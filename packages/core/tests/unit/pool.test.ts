import { describe, expect, it } from 'vitest'
import { pool } from '../../src/apply.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('parallel work lifetime', () => {
  it('drains in-flight workers after failure before rejecting and starts no new work', async () => {
    const entered = deferred()
    const failed = deferred()
    const release = deferred()
    const error = new Error('upload disconnected')
    const started: number[] = []
    let settled = false
    let finished = false
    const run = pool([0, 1, 2], 2, async (item) => {
      started.push(item)
      if (item === 0) {
        await entered.promise
        failed.resolve()
        throw error
      }
      entered.resolve()
      await release.promise
      finished = true
    }).then(
      () => {
        settled = true
      },
      (reason) => {
        settled = true
        throw reason
      }
    )
    const rejected = expect(run).rejects.toBe(error)
    try {
      await failed.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(finished).toBe(false)
      expect(started).toEqual([0, 1])
    } finally {
      release.resolve()
      await rejected
    }
    expect(finished).toBe(true)
    expect(started).toEqual([0, 1])
  })
})
