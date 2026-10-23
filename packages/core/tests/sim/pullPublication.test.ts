import { legacyState } from '../helpers/legacyState.js'
import { expect, it } from 'vitest'
import { ExpectedWrites, pull, sha256, type EngineClient } from '../../src/index.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { EpochError, SimScheduler } from './scheduler.js'
import { SyncCancelled } from '../../src/cancellation.js'

it.each(
  (['buffered', 'bounded', 'stage'] as const).flatMap((mode) =>
    [1, 3].flatMap((placementConcurrency) =>
      (placementConcurrency === 3 ? [false, true] : [false]).map((legacy) => ({
        mode,
        placementConcurrency,
        legacy,
      }))
    )
  )
)(
  'first-pull publication and batched page progress survive every await (mode=$mode, placement=$placementConcurrency, legacy=$legacy)',
  async ({ mode, placementConcurrency, legacy }) => {
    const bounded = mode !== 'buffered'
    const versions = await Promise.all(
      Array.from({ length: 3 }, async (_, n) => {
        const bytes = new Uint8Array([n + 1])
        return {
          file_id: `file-${n}`,
          version_id: 'v1',
          path: `file-${n}.bin`,
          seq: n + 1,
          kind: 'attachment' as const,
          sha: await sha256(bytes),
          size: 1,
          mtime: 1,
          bytes,
        }
      })
    )
    async function execute(cut?: string, interruption: 'crash' | 'cancel' | 'failure' = 'crash') {
      const scheduler = new SimScheduler(151)
      let stop = new AbortController(),
        interrupted = false
      const injected = new Error('injected placement failure')
      const lateAcknowledgements: string[] = []
      let fs = new MemoryStreamingFS(scheduler),
        state = new DurableStateStore(scheduler)
      const downloads: string[] = []
      const client = (): EngineClient =>
        ({
          manifest: async (cursor: string | null) => {
            await scheduler.point('net.manifest')
            return {
              items: (cursor === null ? versions.slice(0, 2) : versions.slice(2)).map(
                ({ bytes: _bytes, ...item }) => item
              ),
              head_seq: 3,
              next: cursor === null ? 'next' : null,
            }
          },
          changes: async () => {
            await scheduler.point('net.changes')
            return { items: [], head_seq: 3, next_since: 3 }
          },
          getBlob: async (sha: string) => {
            await scheduler.point('net.getBlob')
            const item = versions.find((item) => item.sha === sha)!
            downloads.push(item.file_id)
            return item.bytes
          },
          ...(bounded
            ? {
                openVersion: async (id: string) => {
                  const epoch = scheduler.epoch,
                    item = versions.find((item) => item.file_id === id)!
                  await scheduler.point('net.openVersion', epoch)
                  downloads.push(id)
                  return {
                    size: 1,
                    read: async () => {
                      await scheduler.point('net.read', epoch)
                      return item.bytes
                    },
                    assertUnchanged: async () => {
                      await scheduler.point('net.validate', epoch)
                    },
                    close: async () => {
                      await scheduler.point('net.close', epoch)
                    },
                  }
                },
              }
            : {}),
        }) as unknown as EngineClient
      if (!bounded) {
        // Keep the scheduled conditional-file/receipt ports while selecting the buffered lane.
        Object.assign(fs, { beginAtomicWrite: undefined, reopenStage: undefined })
      }
      const run = () =>
        pull(client(), fs, legacy ? legacyState(state) : state, {
          placementConcurrency,
          signal: stop.signal,
          onApplied: (event) => {
            if (stop.signal.aborted) lateAcknowledgements.push(event.path)
          },
          expected: new ExpectedWrites(),
          dirty: new Set(),
          filter: { excluded: () => false },
          ...(mode === 'stage' ? { prefetchBytes: 0 } : {}),
        })
      scheduler.cut = interruption === 'crash' ? cut : undefined
      scheduler.hook = async (point) => {
        if (interruption === 'crash' || point !== cut || interrupted) return
        interrupted = true
        if (interruption === 'cancel') stop.abort()
        else throw injected
      }
      try {
        await run()
      } catch (error) {
        if (
          !cut ||
          !(error instanceof EpochError || error instanceof SyncCancelled || error === injected)
        )
          throw error
      }
      const points = scheduler.points.slice()
      expect(lateAcknowledgements).toEqual([])
      if (cut) {
        if (interruption === 'crash') expect(scheduler.epoch).toBe(1)
        else expect(interrupted).toBe(true)
        scheduler.cut = undefined
        scheduler.hook = undefined
        stop = new AbortController()
        fs = fs.reopen()
        if (!bounded) Object.assign(fs, { beginAtomicWrite: undefined, reopenStage: undefined })
        state = state.reopen()
        const installed = new Set(fs.snapshot().keys())
        const start = downloads.length
        const result = await run().catch((error) => {
          console.error({ mode, placementConcurrency, legacy, cut, interruption })
          throw error
        })
        expect(result.held).toEqual([])
        for (const id of downloads.slice(start)) expect(installed.has(`${id}.bin`)).toBe(false)
      }
      expect(await state.getCursor()).toBe(3)
      for (const item of versions) {
        expect(await fs.read(item.path)).toEqual(item.bytes)
        expect(await state.byFileId(item.file_id)).toMatchObject({
          versionId: item.version_id,
          sha: item.sha,
        })
        expect(await state.getMeta(`pull-write:${item.file_id}`)).toBeNull()
      }
      expect(fs.stages.size).toBe(0)
      return points
    }
    const points = await execute()
    console.log(
      `Placement ${mode}/${placementConcurrency}/legacy=${legacy}: ${points.length} crash cuts` +
        (placementConcurrency > 1 ? `, ${points.length} cancellation and failure cuts each` : '')
    )
    for (const cut of points) await execute(cut)
    if (placementConcurrency > 1) {
      for (const cut of points) {
        await execute(cut, 'cancel')
        await execute(cut, 'failure')
      }
    }
  }
)
