import { expect, it } from 'vitest'
import { ExpectedWrites, pull, sha256, type EngineClient } from '../../src/index.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { EpochError, SimScheduler } from './scheduler.js'

it.each(['buffered', 'bounded', 'stage'] as const)(
  'first-pull publication and batched page progress survive every await (mode=%s)',
  async (mode) => {
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
    async function execute(cut?: string) {
      const scheduler = new SimScheduler(151)
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
        pull(client(), fs, state, {
          expected: new ExpectedWrites(),
          dirty: new Set(),
          filter: { excluded: () => false },
          ...(mode === 'stage' ? { prefetchBytes: 0 } : {}),
        })
      scheduler.cut = cut
      try {
        await run()
      } catch (error) {
        if (!(error instanceof EpochError) || !cut) throw error
      }
      const points = scheduler.points.slice()
      if (cut) {
        expect(scheduler.epoch).toBe(1)
        scheduler.cut = undefined
        fs = fs.reopen()
        if (!bounded) Object.assign(fs, { beginAtomicWrite: undefined, reopenStage: undefined })
        state = state.reopen()
        const installed = new Set(fs.snapshot().keys())
        const start = downloads.length
        const result = await run()
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
    for (const cut of points) await execute(cut)
  }
)
