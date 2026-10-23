import { describe, expect, it, vi } from 'vitest'
import * as Core from '../legacy/index.js'

function fixture(gated = true) {
  const state = new Core.MemoryStateStore(),
    fs = new Core.MemoryFileSystem()
  const fetch = vi.fn(async () => {
    throw new Error('no network during recovery')
  })
  const client = new Core.SyncClient({
    baseUrl: 'https://synthetic.example.test',
    token: 'device',
    fetch,
  }).forVault('vault')
  let ready = false,
    owned = true
  const recovery = {
    assertReady() {
      if (!owned) throw new Core.EngineError('lost', 'runtime retired')
      if (!ready) throw new Core.ExternalStateError('recovery-required')
    },
  }
  const writes = vi.spyOn(state, 'setMeta')
  const engine = new Core.SyncEngine({
    client,
    state,
    fs,
    selective: Core.selectiveDefaults(),
    ...(gated ? { recovery } : {}),
  })
  return {
    engine,
    state,
    fs,
    fetch,
    writes,
    ready: () => {
      ready = true
    },
    retire: () => {
      owned = false
    },
  }
}
describe('opt-in core recovery readiness', () => {
  it('gates constructor scope effects while preserving the legacy constructor default', async () => {
    const gated = fixture(),
      legacy = fixture(false)
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(gated.writes).not.toHaveBeenCalled()
      expect(legacy.writes).toHaveBeenCalled()
      gated.ready()
      await gated.engine.recordScope()
      expect(gated.writes).toHaveBeenCalled()
    } finally {
      await gated.engine.stop()
      await legacy.engine.stop()
    }
  })
  for (const verb of [
    'sync',
    'rescan',
    'recordScope',
    'decideDeletes',
    'applyDeferred',
    'keepLocal',
    'restore',
    'restoreDeleted',
  ] as const)
    it(`${verb} cannot mutate, replay publication or Restore before recovery`, async () => {
      const f = fixture()
      try {
        await expect(
          Promise.resolve().then<unknown>(() => {
            if (verb === 'decideDeletes') return f.engine.decideDeletes('restore', ['file'])
            if (verb === 'restore') return f.engine.restore('file', 'version', 'request')
            if (verb === 'restoreDeleted') return f.engine.restoreDeleted('file', 'request')
            return f.engine[verb]()
          })
        ).rejects.toMatchObject({ reason: 'recovery-required' })
        expect(f.fetch).not.toHaveBeenCalled()
        expect(f.writes).not.toHaveBeenCalled()
      } finally {
        await f.engine.stop()
      }
    })
  it('gates public exclusive preparation and rechecks readiness after preparation awaits', async () => {
    const f = fixture()
    let prepared = false,
      ran = false
    const job = async () => {
      ran = true
    }
    try {
      await expect(
        f.engine.runExclusive(job, {
          before: async () => {
            prepared = true
          },
        })
      ).rejects.toMatchObject({ reason: 'recovery-required' })
      expect(prepared).toBe(false)
      f.ready()
      await expect(
        f.engine.runExclusive(job, {
          before: async () => {
            prepared = true
            f.retire()
          },
        })
      ).rejects.toMatchObject({ code: 'lost' })
      expect(prepared).toBe(true)
      expect(ran).toBe(false)
    } finally {
      await f.engine.stop()
    }
  })
  it('rechecks public exclusive readiness after waiting behind another host effect', async () => {
    const f = fixture()
    f.ready()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const running = f.engine.runExclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
          entered()
        })
    )
    await started
    let ran = false
    const waiting = f.engine.runExclusive(async () => {
      ran = true
    })
    try {
      await Promise.all([
        expect(waiting).rejects.toMatchObject({ code: 'lost' }),
        (async () => {
          f.retire()
          release()
          await running
        })(),
      ])
      expect(ran).toBe(false)
    } finally {
      release()
      await f.engine.stop()
    }
  })
  it('start/resume cannot activate watchers or timers before recovery', async () => {
    const f = fixture(),
      watch = vi.spyOn(f.fs, 'watch')
    try {
      expect(() => f.engine.start()).toThrowError(
        expect.objectContaining({ reason: 'recovery-required' })
      )
      expect(() => f.engine.resume()).toThrowError(
        expect.objectContaining({ reason: 'recovery-required' })
      )
      expect(watch).not.toHaveBeenCalled()
      expect(f.fetch).not.toHaveBeenCalled()
    } finally {
      await f.engine.stop()
    }
  })
  it('stop waits for an already-issued Restore outcome instead of abandoning it as a read', async () => {
    let issued!: () => void
    const sent = new Promise<void>((resolve) => {
      issued = resolve
    })
    let reply!: (value: Response) => void
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve
          issued()
        })
    )
    const client = new Core.SyncClient({
      baseUrl: 'https://synthetic.example.test',
      token: 'device',
      fetch,
    }).forVault('vault')
    const engine = new Core.SyncEngine({
      client,
      state: new Core.MemoryStateStore(),
      fs: new Core.MemoryFileSystem(),
      selective: Core.selectiveDefaults(),
      recovery: { assertReady() {} },
    })
    const restoring = engine.restore('file', 'old', 'request')
    void restoring.catch(() => {})
    await sent
    let stopped = false
    const stopping = engine.stop().then(() => {
      stopped = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(stopped).toBe(false)
    } finally {
      reply(
        new Response(
          JSON.stringify({
            status: 'applied',
            file_id: 'file',
            version_id: 'restored',
            seq: 1,
            path: 'a.bin',
            sha: 'a'.repeat(64),
            size: 1,
            mtime: 1,
          })
        )
      )
      await stopping
    }
    await expect(restoring).resolves.toMatchObject({ status: 'applied' })
  })
  it('a recovered but retired runtime cannot start new effects', async () => {
    const f = fixture()
    try {
      f.ready()
      await f.engine.recordScope()
      f.retire()
      f.writes.mockClear()
      await expect(f.engine.applyDeferred()).rejects.toMatchObject({ code: 'lost' })
      await expect(f.engine.sync()).rejects.toMatchObject({ code: 'lost' })
      expect(f.fetch).not.toHaveBeenCalled()
      expect(f.writes).not.toHaveBeenCalled()
    } finally {
      await f.engine.stop()
    }
  })
})
