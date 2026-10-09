import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_SELECTIVE,
  encodeText,
  MemoryFileSystem,
  MemoryStateStore,
  SyncEngine,
} from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('public engine exclusive operations', () => {
  let h: Harness, token: string
  const engines: SyncEngine[] = []
  beforeAll(async () => {
    h = await serverHarness()
    token = (await h.account('exclusive@abele.test')).accountToken
  })
  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.stop()
  })
  afterAll(async () => {
    await h.close()
  })
  async function fixture() {
    const { vaultId } = await h.vault(token, 'exclusive')
    const { deviceToken } = await h.device(token, vaultId, 'exclusive device')
    const client = h.clientFor(deviceToken, vaultId)
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const engine = new SyncEngine({ client, fs, state, selective: DEFAULT_SELECTIVE })
    engines.push(engine)
    return { engine, client, fs, state }
  }

  it('waits for a running cycle and excludes later sync work until the operation finishes', async () => {
    const { engine, client } = await fixture()
    const entered = gate(),
      releaseCycle = gate(),
      releaseOperation = gate()
    const manifest = client.manifest.bind(client)
    client.manifest = async (...args) => {
      entered.release()
      await releaseCycle.promise
      return manifest(...args)
    }
    const events: string[] = []
    const cycle = engine.sync().then(() => events.push('cycle'))
    await entered.promise
    let operationEntered = false
    let operation: Promise<string> | undefined, following: Promise<unknown> | undefined
    try {
      operation = engine.runExclusive(async () => {
        operationEntered = true
        events.push('operation')
        await releaseOperation.promise
        return 'evicted'
      })
      await turn()
      expect(operationEntered).toBe(false)
      releaseCycle.release()
      await cycle
      await turn()
      expect(operationEntered).toBe(true)
      following = engine.sync().then(() => events.push('following'))
      await turn()
      expect(events).toEqual(['cycle', 'operation'])
      releaseOperation.release()
      await expect(operation).resolves.toBe('evicted')
      await following
      expect(events).toEqual(['cycle', 'operation', 'following'])
    } finally {
      releaseCycle.release()
      releaseOperation.release()
      await Promise.allSettled([cycle, operation, following])
    }
  })

  it('serializes multiple host jobs and releases the scheduler after a synchronous throw or rejection', async () => {
    const { engine } = await fixture()
    const release = gate(),
      entered = gate()
    const events: string[] = []
    const first = engine.runExclusive(async () => {
      events.push('first')
      entered.release()
      await release.promise
      throw new Error('operation failed')
    })
    const rejected = expect(first).rejects.toThrow('operation failed')
    await entered.promise
    const second = engine.runExclusive(async () => {
      events.push('second')
      return 42
    })
    try {
      await turn()
      expect(events).toEqual(['first'])
    } finally {
      release.release()
    }
    await rejected
    await expect(second).resolves.toBe(42)
    await expect(
      engine.runExclusive(() => {
        throw new Error('synchronous failure')
      })
    ).rejects.toThrow('synchronous failure')
    await expect(engine.sync()).resolves.toMatchObject({ push: { applied: 0 } })
    expect(events).toEqual(['first', 'second'])
  })

  it('stop does not release an in-flight host effect early, and drains a promised sync', async () => {
    const { engine } = await fixture()
    const entered = gate(),
      release = gate()
    const operation = engine.runExclusive(async () => {
      entered.release()
      await release.promise
      return 'recorded'
    })
    await entered.promise
    const following = engine.sync()
    let stopped = false
    const stopping = engine.stop().then(() => {
      stopped = true
    })
    try {
      await turn()
      expect(stopped).toBe(false)
    } finally {
      release.release()
      await operation
      await following
      await stopping
    }
    expect(stopped).toBe(true)
    await expect(operation).resolves.toBe('recorded')
  })

  it('cancelling a blocked sync read lets a waiting host operation take the same scheduler', async () => {
    const { engine, client } = await fixture()
    const entered = gate(),
      release = gate()
    const manifest = client.manifest.bind(client)
    client.manifest = async (...args) => {
      entered.release()
      await release.promise
      return manifest(...args)
    }
    const cycle = engine.sync()
    const cancelled = expect(cycle).rejects.toMatchObject({ code: 'offline' })
    await entered.promise
    let operation: Promise<string> | undefined
    try {
      operation = engine.runExclusive(async () => 'safe bookkeeping')
      await engine.stop()
      await expect(operation).resolves.toBe('safe bookkeeping')
    } finally {
      await engine.stop()
      release.release()
      await cancelled
      await Promise.allSettled([cycle, operation])
    }
  })

  it('publishes an unsynced edit before acquiring exclusivity and revalidates the same file inside', async () => {
    const { engine, fs, state, client } = await fixture()
    await fs.writeAtomic('attachment.bin', encodeText('original'), 1)
    await engine.sync()
    const original = await state.get('attachment.bin')
    await fs.writeAtomic('attachment.bin', encodeText('unsynced edit'), 2)
    const events: string[] = []
    await engine.runExclusive(
      async () => {
        events.push('exclusive')
        const published = await state.get('attachment.bin')
        expect(published?.fileId).toBe(original?.fileId)
        expect(published?.versionId).not.toBe(original?.versionId)
        expect(published?.sha).not.toBe(original?.sha)
        const head = (await client.manifest(null)).items.find(
          (item) => item.file_id === published?.fileId
        )
        expect(head?.sha).toBe(published?.sha)
      },
      {
        before: async () => {
          events.push('publication')
          await engine.sync()
          events.push('published')
        },
      }
    )
    expect(events).toEqual(['publication', 'published', 'exclusive'])
  })

  it('does not run the exclusive effect if publication fails', async () => {
    const { engine } = await fixture()
    let ran = false
    await expect(
      engine.runExclusive(
        async () => {
          ran = true
        },
        {
          before: async () => {
            throw new Error('publication offline')
          },
        }
      )
    ).rejects.toThrow('publication offline')
    expect(ran).toBe(false)
    await expect(engine.runExclusive(async () => 'next')).resolves.toBe('next')
  })
})
