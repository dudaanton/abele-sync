import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import { applyStaged, pull, type PullOptions } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'
import { placementFootprints, placementWaves } from '../../src/placement.js'

async function fixture(count = 32) {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  const changes: ChangeItem[] = Array.from({ length: count }, (_, n) => ({
    file_id: `f${n}`,
    version_id: 'v1',
    path: `folder/${n}.bin`,
    seq: n + 1,
    op: 'create',
    prev_path: null,
    sha,
    size: 1,
    mtime: 1,
    kind: 'attachment',
    actor: { kind: 'system', id: 'remote', name: 'remote' },
    at: '',
  }))
  const client = {
    manifest: async () => ({ items: changes, next: null, head_seq: count }),
    changes: async () => ({ items: [], next_since: count, head_seq: count }),
    getBlob: async () => bytes,
  } as unknown as EngineClient
  const applied: string[] = []
  const options: PullOptions = {
    filter: { excluded: () => false },
    dirty: new Set(),
    expected: new ExpectedWrites(),
    onApplied: (event) => {
      applied.push(event.path)
    },
    ...{ placementConcurrency: 32 },
  }
  return {
    fs,
    state,
    changes,
    client,
    applied,
    options,
    run: (staged = false) =>
      staged ? applyStaged(client, fs, state, changes, options) : pull(client, fs, state, options),
  }
}

it.each([false, true])(
  'overlaps 32 independent placements with ordered settlement (staged=%s)',
  async (staged) => {
    const f = await fixture()
    let active = 0,
      peak = 0,
      barriers = 0,
      generation = 0,
      durable = 0,
      fileBarriers = 0
    let barrier: Promise<void> | undefined
    const flush = async (required: number) => {
      while (durable < required) {
        if (!barrier) {
          const started = generation
          barrier = new Promise<void>((resolve) =>
            setTimeout(() => {
              durable = started
              barrier = undefined
              barriers++
              resolve()
            }, 10)
          )
        }
        await barrier
      }
    }
    const original = f.fs.conditionalFile.bind(f.fs)
    vi.spyOn(f.fs, 'conditionalFile').mockImplementation(async (...args) => {
      active++
      peak = Math.max(peak, active)
      const result = await original(...args)
      fileBarriers++
      // A barrier already running cannot cover this mutation generation.
      const required = ++generation
      await flush(required)
      expect(durable).toBeGreaterThanOrEqual(required)
      active--
      return result
    })
    const result = await f.run(staged)
    expect(result.applied).toBe(32)
    expect(f.applied).toEqual(f.changes.map((c) => c.path))
    for (const c of f.changes) {
      expect((await f.state.byFileId(c.file_id))?.sha).toBe(c.sha)
      expect(await sha256(await f.fs.read(c.path))).toBe(c.sha)
    }
    expect(peak).toBe(32)
    expect(fileBarriers).toBe(32)
    expect(barriers).toBeLessThanOrEqual(3)
  }
)

it('serializes overlapping moves through the source and destination pair', async () => {
  const f = await fixture(2)
  for (const [n, source, target] of [
    [0, 'b.bin', 'c.bin'],
    [1, 'a.bin', 'b.bin'],
  ] as const) {
    const c = f.changes[n]!
    await f.fs.writeAtomic(source, new Uint8Array([1]), 1)
    await f.state.put({
      path: source,
      wirePath: source,
      fileId: c.file_id,
      versionId: 'old',
      sha: c.sha!,
      size: 1,
      mtime: 1,
    })
    Object.assign(c, { path: target, prev_path: source, op: 'move' })
  }
  expect((await f.run(true)).applied).toBe(2)
  expect((await f.state.byFileId('f0'))?.path).toBe('c.bin')
  expect((await f.state.byFileId('f1'))?.path).toBe('b.bin')
  expect(await f.fs.stat('a.bin')).toBeNull()
  expect(f.applied).toEqual(['c.bin', 'b.bin'])
})

it('takes only the newest same-path version of one identity', async () => {
  const f = await fixture(2)
  f.changes[1] = { ...f.changes[0]!, seq: 2, version_id: 'v2' }
  const report = await f.run(true)
  expect(report.applied).toBe(1)
  expect((await f.state.byFileId('f0'))?.versionId).toBe('v2')
  expect(f.applied).toEqual([f.changes[0]!.path])
})

it.each([0, -1, 33, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid placement concurrency %s',
  async (value) => {
    const f = await fixture(1)
    Object.assign(f.options, { placementConcurrency: value })
    await expect(f.run()).rejects.toThrow(/placementConcurrency/)
    expect(await f.fs.stat(f.changes[0]!.path)).toBeNull()
  }
)

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

it.each(['cancel', 'failure'] as const)(
  'drains issued writes and blocks later acknowledgements on %s',
  async (mode) => {
    const f = await fixture(4),
      first = gate(),
      last = gate(),
      entered = gate()
    Object.assign(f.options, { placementConcurrency: 3 })
    const stop = new AbortController()
    f.options.signal = stop.signal
    const original = f.fs.conditionalFile.bind(f.fs)
    let active = 0,
      calls = 0,
      finished = false
    vi.spyOn(f.fs, 'conditionalFile').mockImplementation(async (...args) => {
      const n = calls++
      active++
      const result = await original(...args)
      if (n === 2) entered.release()
      try {
        if (n === 0) {
          await first.promise
          if (mode === 'failure') throw new Error('barrier failed')
        }
        if (n === 2) await last.promise
        return result
      } finally {
        active--
      }
    })
    const running = f
      .run()
      .catch((error) => error)
      .finally(() => {
        finished = true
      })
    await entered.promise
    expect(f.applied).toEqual([])
    expect(await f.state.getCursor()).toBe(0)
    expect(await f.state.byFileId('f1')).toBeNull()
    if (mode === 'cancel') stop.abort()
    first.release()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(finished).toBe(false)
    last.release()
    expect(await running).toBeInstanceOf(Error)
    expect(active).toBe(0)
    expect(calls).toBe(3)
    expect(f.applied).toEqual([])
    expect(await f.state.getCursor()).toBe(0)
    delete f.options.signal
    vi.restoreAllMocks()
    const recovered = await f.run()
    expect(recovered.held).toEqual([])
    expect(await f.state.getCursor()).toBe(4)
    for (const c of f.changes) expect((await f.state.byFileId(c.file_id))?.sha).toBe(c.sha)
  }
)

it.each(['cancel', 'failure'] as const)(
  'does not settle successors after transaction %s',
  async (mode) => {
    const f = await fixture(3),
      stop = new AbortController()
    f.options.signal = stop.signal
    const transaction = f.state.transaction.bind(f.state)
    vi.spyOn(f.state, 'transaction').mockImplementation((fn) =>
      transaction(async (tx) => {
        const put = tx.put.bind(tx)
        tx.put = async (entry) => {
          await put(entry)
          if (entry.fileId === 'f0') {
            if (mode === 'cancel') stop.abort()
            else throw new Error('transaction failed')
          }
        }
        return fn(tx)
      })
    )
    await expect(f.run()).rejects.toThrow()
    expect(f.applied).toEqual([])
    expect(await f.state.byFileId('f0')).toBeNull()
    expect(await f.state.byFileId('f1')).toBeNull()
    expect(await f.state.getCursor()).toBe(0)
    delete f.options.signal
    vi.restoreAllMocks()
    await f.run()
    expect(await f.state.getCursor()).toBe(3)
  }
)

it('keeps an earlier held row below the cursor while independent rows settle', async () => {
  const f = await fixture(4)
  f.options.dirty.add(f.changes[0]!.path)
  const report = await f.run()
  expect(report.held.map((c) => c.file_id)).toEqual(['f0'])
  expect(report.applied).toBe(3)
  expect(report.cursor).toBe(0)
  expect(f.applied).toEqual(f.changes.slice(1).map((c) => c.path))
  f.options.dirty.clear()
  expect((await f.run()).cursor).toBe(4)
})

it.each(['same path', 'case alias', 'ancestor', 'identity', 'move', 'implicit move', 'same file'])(
  'serializes %s footprints',
  async (kind) => {
    const f = await fixture(3)
    const a = f.changes[0]!,
      b = f.changes[1]!
    if (kind === 'same path') b.path = a.path
    if (kind === 'case alias') b.path = a.path.toUpperCase()
    if (kind === 'ancestor') b.path = a.path + '/child'
    if (kind === 'identity') f.fs.fileIdentity = async () => 'shared-inode'
    if (kind === 'move') {
      b.op = 'move'
      b.prev_path = a.path
    }
    if (kind === 'same file') b.file_id = a.file_id
    if (kind === 'implicit move')
      await f.state.put({
        fileId: b.file_id,
        versionId: 'old',
        path: 'old.bin',
        wirePath: 'old.bin',
        sha: b.sha!,
        size: 1,
        mtime: 1,
      })
    const footprints = await placementFootprints(f.changes, f.state, f.fs)
    const waves = [...placementWaves(f.changes, 32, footprints)]
    expect(waves.find((wave) => wave.includes(a))!.includes(b)).toBe(false)
    expect(waves.flat()).toEqual(f.changes)
    if (kind.includes('move')) expect(waves.find((wave) => wave.includes(b))).toEqual([b])
  }
)
