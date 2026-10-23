import { expect, it, vi } from 'vitest'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { scan } from '../../src/scanner.js'
import { ScopeMarks } from '../../src/scope.js'
import { selectiveDefaults } from '../../src/selective.js'
import { reconciliationScan } from '../../src/reconciliation.js'
import { ScanWork } from '../../src/scanWork.js'

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
