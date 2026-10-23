import { expect, it, vi } from 'vitest'
import { ExpectedWrites, sha256, type EngineClient } from '../../src/index.js'
import { recoverPendingPullWrites } from '../../src/pullRecovery.js'
import { PullPlacer } from '../../src/pullPlace.js'
import { V2Directories } from '../../src/v2Directories.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { SimScheduler, EpochError } from './scheduler.js'
import type { ChangeItem } from '@abele/sync-protocol'

it.each(['source', 'destination'] as const)(
  'D-204 recovery preserves stage and intent under a %s directory hold across every crash',
  async (side) => {
    async function execute(cut?: string) {
      const scheduler = new SimScheduler(204)
      let fs = new MemoryStreamingFS(scheduler),
        state = new DurableStateStore(scheduler)
      const bytes = new Uint8Array([1, 2, 3]),
        sha = await sha256(bytes)
      const base = {
        path: 'source/a.bin',
        wirePath: 'source/a.bin',
        fileId: 'f',
        versionId: 'v1',
        sha,
        size: 3,
        mtime: 1,
      }
      const change: ChangeItem = {
        seq: 2,
        file_id: 'f',
        version_id: 'v2',
        path: 'destination/a.bin',
        prev_path: base.path,
        op: 'move',
        kind: 'attachment',
        sha,
        size: 3,
        mtime: 1,
        actor: { kind: 'system', id: 'test', name: 'test' },
        at: '',
      }
      await fs.writeAtomic(base.path, bytes, 1)
      await state.put(base)
      const stage = await fs.beginAtomicWrite(change.path, 1, { sha, size: 3, mtime: 1 })
      await stage.append(0, bytes)
      await stage.seal({ sha, size: 3 })
      const intent = JSON.stringify({
        seq: 2,
        fileId: 'f',
        versionId: 'v2',
        wirePath: change.path,
        target: change.path,
        from: base.path,
        base,
        sha,
        size: 3,
        mtime: 1,
        stageId: stage.id,
        sourceIdentity: await fs.fileIdentity(base.path),
      })
      await state.setMeta('pull-write:f', intent)
      const refusal = JSON.stringify({
        directories: [],
        removals: [],
        refused: [
          {
            path: side,
            code: 'conflict',
            message: 'directory evidence held',
            direction: 'push',
            evidence: true,
          },
        ],
      })
      await state.setMeta('v2-directories', refusal)
      fs = fs.reopen()
      state = state.reopen()
      const network = vi.fn(async () => {
        throw new Error('retained bytes need no transfer')
      })
      const client = { getBlob: network, openVersion: network } as unknown as EngineClient
      const run = async () => {
        const dirs = new V2Directories(
          fs,
          state,
          () => true,
          async () => []
        )
        await dirs.loadRefusals()
        client.pathRefusal = (path) => dirs.refusalFor(path)
        return recoverPendingPullWrites(fs, state, ['f'], client)
      }
      const start = scheduler.points.length
      scheduler.cut = cut
      try {
        await run()
      } catch (error) {
        if (!(error instanceof EpochError) || !cut) throw error
      }
      const points = scheduler.points.slice(start)
      if (cut) {
        scheduler.cut = undefined
        fs = fs.reopen()
        state = state.reopen()
      }
      const report = await run()
      expect(fs.snapshot().get(base.path)).toEqual(bytes)
      expect(report).toMatchObject({
        held: [expect.objectContaining({ file_id: 'f', version_id: 'v2' })],
      })
      expect(fs.snapshot().has(change.path)).toBe(false)
      expect(await state.getMeta('pull-write:f')).toBe(intent)
      expect(await state.byFileId('f')).toEqual(base)
      expect(fs.stages.get(stage.id)?.bytes).toEqual(bytes)
      // Placement itself must enforce the same gate, including portable recovery
      // before a client's directory state has been prepared.
      delete client.pathRefusal
      const placer = new PullPlacer(
        client,
        fs,
        state,
        { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } },
        sha256
      )
      expect(await placer.place(change, sha, base, new Map(), new Map())).toBe(false)
      expect(await recoverPendingPullWrites(fs, state, ['f'], client)).toMatchObject({
        held: [expect.objectContaining({ file_id: 'f' })],
      })
      expect(await state.getMeta('pull-write:f')).toBe(intent)
      expect(network).not.toHaveBeenCalled()
      await state.setMeta('v2-directories', JSON.stringify({ directories: [], removals: [] }))
      await recoverPendingPullWrites(fs, state, ['f'], client)
      expect(fs.snapshot().get(change.path)).toEqual(bytes)
      expect(fs.snapshot().has(base.path)).toBe(false)
      expect(await state.getMeta('pull-write:f')).toBeNull()
      expect(await state.byFileId('f')).toMatchObject({ versionId: 'v2', path: change.path })
      return points
    }
    for (const cut of await execute()) await execute(cut)
  }
)
