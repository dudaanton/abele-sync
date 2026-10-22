import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { pull } from '../../src/puller.js'
import {
  sha256,
  ExpectedWrites,
  EngineError,
  type EngineClient,
  type FileSystem,
} from '../../src/index.js'
import { SimScheduler } from './scheduler.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { DurableStateStore } from './durableState.js'

// Bounded CI property: replay a save at every scheduled await, never a combinatorial sweep.
for (const mode of ['buffered', 'streamed', 'move', 'eviction', 'delete'] as const) {
  for (const editPath of mode === 'move' ? ['old.bin', 'new.bin'] : ['old.bin']) {
    it(`I2: ${mode} retains a local save at ${editPath} injected at every pull await`, async () => {
      async function run(inject?: string) {
        const scheduler = new SimScheduler(17),
          disk = new MemoryStreamingFS(scheduler),
          state = new DurableStateStore(scheduler)
        const fs: FileSystem =
          mode === 'streamed'
            ? disk
            : new Proxy(disk, {
                get(target, key) {
                  if (['beginAtomicWrite', 'reopenStage', 'openRead'].includes(String(key)))
                    return undefined
                  const value = Reflect.get(target, key)
                  return typeof value === 'function' ? value.bind(target) : value
                },
              })
        const original = new Uint8Array([1]),
          remote = new Uint8Array([2]),
          edit = new Uint8Array([3]),
          later = new Uint8Array([4])
        await disk.writeAtomic('old.bin', original, 1)
        await state.put({
          path: 'old.bin',
          wirePath: 'old.bin',
          fileId: mode === 'eviction' ? 'occupant' : 'file',
          versionId: 'a',
          sha: await sha256(original),
          size: 1,
          mtime: 1,
        })
        await state.setCursor(1)
        const change: ChangeItem = {
          seq: 2,
          file_id: 'file',
          version_id: 'b',
          path: mode === 'move' ? 'new.bin' : 'old.bin',
          prev_path: mode === 'move' ? 'old.bin' : null,
          op: mode === 'delete' ? 'delete' : mode === 'move' ? 'move' : 'modify',
          sha: mode === 'delete' ? null : await sha256(remote),
          size: 1,
          mtime: 1,
          kind: 'attachment',
          actor: { kind: 'system', id: 'server', name: 'server' },
          at: '',
        }
        const second = {
          ...change,
          seq: 3,
          version_id: 'c',
          op: mode === 'delete' ? ('delete' as const) : ('modify' as const),
          prev_path: null,
          sha: mode === 'delete' ? null : await sha256(later),
        }
        const mark = scheduler.points.length
        let injected = false
        scheduler.hook = async (point) => {
          if (point === inject && !injected) {
            injected = true
            await disk.writeAtomic(editPath, edit, 1)
          }
        }
        const client = {
          changes: async (since: number) => {
            await scheduler.point('client.changes.before')
            const response = {
              items: since < 2 ? [change] : since < 3 ? [second] : [],
              next_since: since < 2 ? 2 : 3,
              head_seq: 3,
            }
            await scheduler.point('client.changes.after')
            return response
          },
          getBlob: async (sha: string) => {
            await scheduler.point('client.getBlob.before')
            const bytes = sha === change.sha ? remote : later
            await scheduler.point('client.getBlob.after')
            return bytes
          },
          openVersion: async (_file: string, _version: string, identity: { sha: string }) => {
            await scheduler.point('client.openVersion.before')
            const bytes = identity.sha === change.sha ? remote : later
            await scheduler.point('client.openVersion.after')
            return {
              size: bytes.length,
              read: async (at: number, length: number) => {
                await scheduler.point('client.source.read.before')
                const part = bytes.slice(at, at + length)
                await scheduler.point('client.source.read.after')
                return part
              },
              assertUnchanged: async () => {
                await scheduler.point('client.source.assertUnchanged')
              },
              close: async () => {
                await scheduler.point('client.source.close')
              },
            }
          },
        } as unknown as EngineClient
        try {
          await pull(client, fs, state, {
            dirty: new Set(),
            expected: new ExpectedWrites(),
            filter: { excluded: () => false },
            protectMissing: true,
          })
        } catch (error) {
          if (!(error instanceof EngineError && error.code === 'conflict')) throw error
        }
        scheduler.hook = undefined
        if (inject) {
          expect(injected, `I2: unreached ${inject}`).toBe(true)
          expect(
            disk.snapshot().get(editPath)?.[0] === 3,
            `I2: lost edit at ${mode}/${inject}`
          ).toBe(true)
        }
        return scheduler.points.slice(mark)
      }
      const points = await run()
      for (const point of points) await run(point)
      expect(points.filter((p) => p.startsWith('state.')).length).toBeGreaterThan(0)
      for (const phase of ['before', 'after']) {
        expect(points.some((p) => p.startsWith(`client.changes.${phase}`))).toBe(true)
        if (mode !== 'delete')
          expect(
            points.some((p) =>
              p.startsWith(
                `${mode === 'streamed' ? 'client.openVersion' : 'client.getBlob'}.${phase}`
              )
            )
          ).toBe(true)
      }
    }, 90_000)
  }
}
