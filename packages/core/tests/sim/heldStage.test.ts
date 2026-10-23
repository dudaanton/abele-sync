import { expect, it } from 'vitest'
import {
  applyStaged,
  EngineError,
  ExpectedWrites,
  sha256,
  type EngineClient,
} from '../../src/index.js'
import type { ChangeItem } from '@abele/sync-protocol'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { EpochError, SimScheduler } from './scheduler.js'

it('retains verified refused bytes and exact intent through every crash and resolves without a download', async () => {
  const bytes = new TextEncoder().encode('incoming'),
    sha = await sha256(bytes)
  const change: ChangeItem = {
    seq: 1,
    file_id: 'f',
    version_id: 'v',
    path: 'a.bin',
    prev_path: null,
    op: 'create',
    kind: 'attachment',
    sha,
    size: bytes.length,
    mtime: 1,
    actor: { kind: 'system', id: 's', name: 's' },
    at: '',
  }
  async function execute(cut?: string) {
    const scheduler = new SimScheduler(182)
    let fs = new MemoryStreamingFS(scheduler),
      state = new DurableStateStore(scheduler)
    let refuse = true,
      opens = 0
    const instrument = () => {
      const begin = fs.beginAtomicWrite.bind(fs),
        reopen = fs.reopenStage.bind(fs)
      const wrap = (stage: Awaited<ReturnType<typeof begin>>) => {
        const commit = stage.commit.bind(stage)
        stage.commit = async (signal) => {
          await scheduler.point('refusal')
          if (refuse) throw new EngineError('conflict', 'local save')
          await commit(signal)
        }
        return stage
      }
      fs.beginAtomicWrite = async (...args) => wrap(await begin(...args))
      fs.reopenStage = async (id) => wrap(await reopen(id))
    }
    instrument()
    const client = {
      openVersion: async () => {
        opens++
        return {
          size: bytes.length,
          read: async (at: number, length: number) => bytes.slice(at, at + length),
          assertUnchanged: async () => {},
          close: async () => {},
        }
      },
    } as unknown as EngineClient
    const run = () =>
      applyStaged(client, fs, state, [change], {
        dirty: new Set(),
        expected: new ExpectedWrites(),
        filter: { excluded: () => false },
        prefetchBytes: 0,
      })
    const start = scheduler.points.length
    scheduler.cut = cut
    try {
      const report = await run()
      expect(report.held).toHaveLength(1)
      expect(fs.stages.size).toBe(1)
      expect([...fs.stages.values()][0]).toMatchObject({ sealed: true, bytes })
      expect(JSON.parse((await state.getMeta('pull-write:f'))!)).toMatchObject({
        versionId: 'v',
        sha,
        target: 'a.bin',
        base: null,
      })
      const before = opens
      await run()
      expect(opens).toBe(before)
      refuse = false
      await run()
      expect(opens).toBe(before)
    } catch (error) {
      if (!(error instanceof EpochError) || !cut) throw error
    }
    const points = scheduler.points.slice(start)
    if (cut) {
      expect(scheduler.epoch, cut).toBe(1)
      scheduler.cut = undefined
      fs = fs.reopen()
      state = state.reopen()
      instrument()
    }
    refuse = false
    // Missing allocation after an intent-only crash is repaired by normal recovery.
    const { recoverPendingPullWrites } = await import('../../src/pullRecovery.js')
    await recoverPendingPullWrites(fs, state, ['f'], client)
    await run()
    expect(fs.snapshot().get('a.bin')).toEqual(bytes)
    expect(await state.byFileId('f')).toMatchObject({ versionId: 'v', sha })
    expect(await state.getMeta('pull-write:f')).toBeNull()
    expect(fs.stages.size).toBe(0)
    return points
  }
  for (const cut of await execute()) await execute(cut)
}, 20000)

it('keeps a save made after sealing visible to scan while recovery retains the incoming bytes', async () => {
  const scheduler = new SimScheduler(182),
    fs = new MemoryStreamingFS(scheduler),
    state = new DurableStateStore(scheduler)
  const bytes = new TextEncoder().encode('incoming'),
    local = new TextEncoder().encode('my edits'),
    sha = await sha256(bytes)
  const begin = fs.beginAtomicWrite.bind(fs)
  fs.beginAtomicWrite = async (...args) => {
    const stage = await begin(...args),
      seal = stage.seal.bind(stage)
    stage.seal = async (identity) => {
      await seal(identity)
      await fs.writeAtomic('a.bin', local, 1)
    }
    return stage
  }
  const client = {
    openVersion: async () => ({
      size: bytes.length,
      read: async (at: number, length: number) => bytes.slice(at, at + length),
      assertUnchanged: async () => {},
      close: async () => {},
    }),
  } as unknown as EngineClient
  const change: ChangeItem = {
    seq: 1,
    file_id: 'f',
    version_id: 'v',
    path: 'a.bin',
    prev_path: null,
    op: 'create',
    kind: 'attachment',
    sha,
    size: bytes.length,
    mtime: 1,
    actor: { kind: 'system', id: 's', name: 's' },
    at: '',
  }
  expect(
    (
      await applyStaged(client, fs, state, [change], {
        dirty: new Set(),
        expected: new ExpectedWrites(),
        filter: { excluded: () => false },
        prefetchBytes: 0,
      })
    ).held
  ).toHaveLength(1)
  const { recoverPendingPullWrites, scan } = await import('../../src/index.js')
  await recoverPendingPullWrites(fs, state, ['f'], client)
  expect(fs.snapshot().get('a.bin')).toEqual(local)
  expect([...fs.stages.values()][0]).toMatchObject({ bytes, sealed: true })
  expect((await scan(fs, state, { excluded: () => false })).ops).toMatchObject([
    { op: 'create', path: 'a.bin', sha: await sha256(local) },
  ])
})
