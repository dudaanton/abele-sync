import { expect, it } from 'vitest'
import {
  applyStaged,
  EngineError,
  ExpectedWrites,
  sha256,
  type EngineClient,
} from '../../src/index.js'
import type { ChangeItem } from '@abele/sync-protocol'
import { recoverPendingPullWrites } from '../../src/pullRecovery.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { EpochError, SimScheduler } from './scheduler.js'

it.each(['count', 'bytes', 'supersede', 'delete'] as const)(
  'held stage %s resolution preserves ownership across every crash',
  async (mode) => {
    const bytes = new TextEncoder().encode('incoming'),
      sha = await sha256(bytes)
    async function execute(cut?: string) {
      const scheduler = new SimScheduler(182)
      let fs = new MemoryStreamingFS(scheduler),
        state = new DurableStateStore(scheduler)
      let opens = 0
      const logs: string[] = []
      const change = (id: string, seq = 1): ChangeItem => ({
        seq,
        file_id: id,
        version_id: `${id}-${seq}`,
        path: `${id}.bin`,
        prev_path: null,
        op: 'create',
        kind: 'attachment',
        sha,
        size: bytes.length,
        mtime: 1,
        actor: { kind: 'system', id: 's', name: 's' },
        at: '',
      })
      const instrument = () => {
        const begin = fs.beginAtomicWrite.bind(fs),
          reopen = fs.reopenStage.bind(fs)
        const wrap = (stage: Awaited<ReturnType<typeof begin>>) => {
          stage.commit = async () => {
            await scheduler.point('refusal')
            throw new EngineError('conflict', 'local conflict')
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
      const limits = mode === 'bytes' ? { count: 10, bytes: 8 } : { count: 2, bytes: 100 }
      const run = (item: ChangeItem) =>
        applyStaged(client, fs, state, [item], {
          dirty: new Set(),
          expected: new ExpectedWrites(),
          filter: { excluded: () => false },
          prefetchBytes: 0,
          heldStageLimits: limits,
          log: (row) => logs.push(row),
        })
      await run(change('a'))
      const original = JSON.parse((await state.getMeta('pull-write:a'))!).stageId as string
      // Recovery must leave a known refusal available to normal scan/push, even
      // if the ledger base changed while the decision was held.
      await recoverPendingPullWrites(fs, state, ['a'], client)
      expect(opens).toBe(1)
      await run(change('a'))
      expect(opens).toBe(1)
      const operation = async () => {
        if (mode === 'count' || mode === 'bytes') {
          await run(change('b', 2))
          await run(change('c', 3))
        } else {
          const next = change('a', 2)
          if (mode === 'delete')
            Object.assign(next, { op: 'delete', sha: null, size: null, mtime: null })
          await run(next)
        }
      }
      scheduler.cut = cut
      const start = scheduler.points.length
      try {
        await operation()
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
        await recoverPendingPullWrites(fs, state, ['a', 'b', 'c'], client)
        await operation()
      }
      expect(fs.stages.has(original), cut).toBe(false)
      expect(fs.stages.size).toBe(mode === 'delete' ? 0 : mode === 'count' ? 2 : 1)
      const ids = new Set<string>()
      for (const key of await state.metadataKeys('pull-write:')) {
        const intent = JSON.parse((await state.getMeta(key))!)
        ids.add(intent.stageId)
        expect(intent.retiring).not.toBe(true)
        expect(fs.stages.has(intent.stageId)).toBe(true)
      }
      expect(ids).toEqual(new Set(fs.stages.keys()))
      if (mode === 'count' || mode === 'bytes') {
        expect(await state.getMeta('pull-write:a')).toBeNull()
        expect(logs.some((row) => row.includes('evicting held stage a.bin'))).toBe(true)
      }
      return points
    }
    for (const cut of await execute()) await execute(cut)
  },
  20000
)
