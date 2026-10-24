import { expect, it, vi } from 'vitest'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { scan } from '../../src/scanner.js'
import { ScopeMarks } from '../../src/scope.js'
import { selectiveDefaults } from '../../src/selective.js'
import { reconciliationScan } from '../../src/reconciliation.js'
import { ScanWork } from '../../src/scanWork.js'
import { refreshLocalPaths } from '../../src/localPaths.js'
import { SyncEngine } from '../../src/engine.js'
import type { EngineClient } from '../../src/engineClient.js'
import { shaIndex } from '../../src/apply.js'
import { recoverPullEvictions } from '../../src/pullEvictions.js'
import { recoverRemovals } from '../../src/removalRetention.js'
import { reconcileGeneration } from '../../src/restoreGeneration.js'
import { scanSnapshot } from '../../src/scanSnapshot.js'
import { V2EngineClient } from '../../src/v2Client.js'
import { encodeAccessToken } from '@abele/sync-protocol'
const filter = { excluded: () => false }
const scope = { selective: selectiveDefaults(), scriptsFolder: 'Scripts' }
it('yields on the time budget even before 256 paths', async () => {
  const now = vi.spyOn(performance, 'now')
  now.mockReturnValue(0)
  const yieldTask = vi.fn(async () => {})
  const work = new ScanWork({ yieldTask })
  try {
    now.mockReturnValue(9)
    await work.step()
    expect(yieldTask).toHaveBeenCalledTimes(1)
  } finally {
    now.mockRestore()
  }
})

it('drains an issued scheduler task before reporting cancellation', async () => {
  const controller = new AbortController()
  let release!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const work = new ScanWork({
    signal: controller.signal,
    yieldTask: async () => {
      entered()
      await gate
    },
  })
  let finished = false
  const run = (async () => {
    for (let n = 0; n < 256; n++) await work.step()
  })()
  const outcome = run.finally(() => {
    finished = true
  })
  const rejected = expect(outcome).rejects.toThrow('sync stopped')
  await started
  controller.abort()
  await Promise.resolve()
  expect(finished).toBe(false)
  release()
  await rejected
})
async function fixture(count: number) {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  for (let n = 0; n < count; n++) {
    const path = `folder/file${n}.bin`
    await fs.writeAtomic(path, new Uint8Array([1]), 1)
    await state.put({
      path,
      wirePath: path,
      fileId: path,
      versionId: 'v1',
      sha: 'a'.repeat(64),
      size: 1,
      mtime: 1,
    })
  }
  await state.setMeta('marked-scope', JSON.stringify(scope))
  fs.read = vi.fn(async () => {
    throw new Error('unchanged inventory must not read content')
  })
  const fingerprint = vi.fn(async (path: string) => ({
    ...(await fs.stat(path))!,
    sha: 'a'.repeat(64),
    generation: 'cached',
  }))
  Object.assign(fs, { fingerprint })
  return { fs, state, fingerprint }
}

it('33k baseline refresh yields a host task inside the cached state iterator', async () => {
  const { fs, state } = await fixture(33000)
  const all = state.all.bind(state)
  let checkpoint = false
  let last = performance.now(),
    longest = 0
  const heartbeat = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 0)
  state.all = async function* () {
    const timer = setTimeout(() => {
      checkpoint = true
    }, 0)
    try {
      yield* all()
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    await refreshLocalPaths(fs, state)
  } finally {
    clearInterval(heartbeat)
  }
  longest = Math.max(longest, performance.now() - last)
  console.info({ paths: 33000, phase: 'refreshLocalPaths', longest })
  expect(checkpoint).toBe(true)
  expect(longest).toBeLessThan(35)
  expect(fs.read).not.toHaveBeenCalled()
})

it.each(['pending', 'blocked', 'unchanged'] as const)(
  'baseline %s early continuation observes host cancellation',
  async (kind) => {
    const { fs, state } = await fixture(1024)
    const controller = new AbortController()
    let active = false
    const all = state.all.bind(state)
    state.all = async function* () {
      active = true
      try {
        yield* all()
      } finally {
        active = false
      }
    }
    if (kind === 'pending') {
      const get = state.getMeta.bind(state)
      state.getMeta = async (key) => (key.startsWith('pull-write:') ? 'pending' : get(key))
    }
    const { LocalPaths } = await import('../../src/localPaths.js')
    const blocked = vi.spyOn(LocalPaths.prototype, 'blocked')
    if (kind === 'blocked') blocked.mockReturnValue(true)
    const put = vi.spyOn(state, 'put')
    try {
      await expect(
        refreshLocalPaths(fs, state, {
          signal: controller.signal,
          yieldTask: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            if (active) controller.abort()
          },
        })
      ).rejects.toThrow('sync stopped')
      expect(put).not.toHaveBeenCalled()
    } finally {
      blocked.mockRestore()
    }
  }
)

it.each([
  'sha index',
  'eviction fallback',
  'retention fallback',
  'generation',
  'v2 prepare',
] as const)('33k %s startup pass yields inside cached iteration', async (phase) => {
  const { fs, state } = await fixture(33000)
  const all = state.all.bind(state)
  let checkpoint = false
  state.all = async function* () {
    const timer = setTimeout(() => {
      checkpoint = true
    }, 0)
    try {
      yield* all()
    } finally {
      clearTimeout(timer)
    }
  }
  if (phase === 'sha index') await shaIndex(state)
  else if (phase === 'generation') await reconcileGeneration(state, 'fresh')
  else if (phase === 'v2 prepare') {
    const scope = { kind: 'folder' as const, id: 'folder', path: 'folder' }
    const client = new V2EngineClient(
      encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
      {
        fetch: async () =>
          Response.json({
            protocol: 2,
            token_id: 'token',
            space_id: 'space',
            scope,
            status: 'active',
            limits: { max_file_bytes: 10000, quota_bytes: null },
          }),
      }
    )
    await client.prepare(fs, state, () => false, undefined, true)
  } else {
    Object.defineProperty(state, 'metadataKeys', { value: undefined })
    if (phase === 'eviction fallback') await recoverPullEvictions(fs, state)
    else await recoverRemovals(fs, state)
  }
  expect(checkpoint).toBe(true)
})

it('33k snapshot materialization yields inside the underlying inventory', async () => {
  const { fs } = await fixture(33000)
  const list = fs.list.bind(fs)
  let checkpoint = false
  fs.list = async function* () {
    const timer = setTimeout(() => {
      checkpoint = true
    }, 0)
    try {
      yield* list()
    } finally {
      clearTimeout(timer)
    }
  }
  for await (const _ of scanSnapshot(fs, () => undefined).fs.list()) {
    /* consume */
  }
  expect(checkpoint).toBe(true)
})

it('33k full cached startup gives every baseline pass a task checkpoint', async () => {
  const { fs, state } = await fixture(33000)
  await state.setCursor(1)
  const all = state.all.bind(state)
  const passes: Array<{ count: number; checkpoint: boolean; caller: string | undefined }> = []
  state.all = async function* () {
    const pass = { count: 0, checkpoint: false, caller: new Error().stack?.split('\n')[2] }
    const timer = setTimeout(() => {
      pass.checkpoint = true
    }, 0)
    try {
      for await (const entry of all()) {
        pass.count++
        yield entry
      }
    } finally {
      clearTimeout(timer)
      passes.push(pass)
    }
  }
  const engine = new SyncEngine({
    fs,
    state,
    selective: scope.selective,
    client: {
      state: async () => ({ head_seq: 1, settings: { max_file_bytes: 10000, quota_bytes: null } }),
      changes: async () => ({ items: [], next_since: 1, head_seq: 1 }),
    } as unknown as EngineClient,
  })
  try {
    await engine.sync()
    expect(passes.filter((p) => p.count >= 256 && !p.checkpoint)).toEqual([])
    expect(fs.read).not.toHaveBeenCalled()
  } finally {
    await engine.stop()
  }
})

it('33k cached startup reaches the first request near 200 ms despite browser timer clamping', async () => {
  const { fs, state } = await fixture(33000)
  await state.setCursor(1)
  const timer = globalThis.setTimeout
  const timers = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((callback: () => void, delay?: number) =>
      timer(callback, Math.max(delay ?? 0, 4))) as typeof setTimeout)
  let first = Infinity
  const started = performance.now()
  const engine = new SyncEngine({
    fs,
    state,
    selective: scope.selective,
    client: {
      state: async () => {
        first = performance.now() - started
        throw new Error('first request')
      },
    } as unknown as EngineClient,
  })
  try {
    await expect(engine.sync()).rejects.toThrow('first request')
    console.info({ paths: 33000, firstRequestMs: first, timeoutYields: timers.mock.calls.length })
    expect(first).toBeLessThan(250)
    expect(fs.read).not.toHaveBeenCalled()
  } finally {
    await engine.stop()
    timers.mockRestore()
  }
})

it('yields a real host task after at most 256 cached paths and checks cancellation', async () => {
  const controller = new AbortController()
  let tasks = 0
  const work = new ScanWork({
    signal: controller.signal,
    yieldTask: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      tasks++
      controller.abort()
    },
  })
  await expect(
    (async () => {
      for (let n = 0; n < 256; n++) await work.step()
    })()
  ).rejects.toThrow('sync stopped')
  expect(tasks).toBe(1)
})

it.each(['scope', 'scan', 'reconciliation'] as const)(
  'cached %s inventory uses the host scheduler and stops before writes',
  async (phase) => {
    const { fs, state } = await fixture(1024)
    const controller = new AbortController()
    const write = vi.spyOn(state, 'setMeta')
    const yieldTask = vi.fn(async () => {
      controller.abort()
    })
    const opts = { signal: controller.signal, yieldTask }
    const run = () =>
      phase === 'scope'
        ? new ScopeMarks(state).record(fs, scope, filter, opts)
        : phase === 'scan'
          ? scan(fs, state, filter, opts)
          : reconciliationScan(
              fs,
              state,
              filter,
              1,
              undefined,
              undefined,
              true,
              undefined,
              controller.signal,
              undefined,
              undefined,
              yieldTask
            )
    await expect(run()).rejects.toThrow('sync stopped')
    expect(yieldTask).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    expect(fs.read).not.toHaveBeenCalled()
  }
)

it('33k unchanged entries yield below 50 ms without content reads or outgoing operations', async () => {
  const { fs, state, fingerprint } = await fixture(33000)
  let phase = 'record',
    slowest = ''
  let last = performance.now(),
    longest = 0,
    ticks = 0
  const timer = setInterval(() => {
    const now = performance.now()
    if (now - last > longest) slowest = phase
    longest = Math.max(longest, now - last)
    last = now
    ticks++
  }, 0)
  try {
    const marks = new ScopeMarks(state)
    await marks.record(fs, scope, filter)
    phase = 'review'
    await marks.review(fs, filter)
    phase = 'reconciliation'
    const inspected = await reconciliationScan(fs, state, filter, 1)
    expect(inspected.found.ops).toEqual([])
    expect(fingerprint).toHaveBeenCalledTimes(16)
    phase = 'scan'
    const result = await scan(fs, state, filter)
    expect(result.ops).toEqual([])
    expect(result.hashes.size).toBe(33000)
  } finally {
    clearInterval(timer)
  }
  longest = Math.max(longest, performance.now() - last)
  console.info({ paths: 33000, ticks, longest, slowest })
  expect(fs.read).not.toHaveBeenCalled()
  expect(ticks).toBeGreaterThan(0)
  expect(longest).toBeLessThan(50)
}, 20000)
