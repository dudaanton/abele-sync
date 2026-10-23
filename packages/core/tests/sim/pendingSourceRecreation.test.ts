import { expect, it } from 'vitest'
import { pull, ExpectedWrites, EngineError, sha256, type EngineClient } from '../../src/index.js'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { DurableStateStore } from './durableState.js'
import { SimScheduler, EpochError } from './scheduler.js'

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'pending private stage never claims a recreated source (streaming=%s, identity=%s)',
  async (streaming, recordedIdentity) => {
    const bytes = new TextEncoder().encode('sample A'),
      sha = await sha256(bytes)
    async function execute(cut?: string) {
      const scheduler = new SimScheduler(186)
      let fs = new MemoryStreamingFS(scheduler),
        state = new DurableStateStore(scheduler)
      const base = {
        path: 'old.md',
        wirePath: 'old.md',
        fileId: 'sample',
        versionId: 'base',
        sha,
        size: bytes.length,
        mtime: 1000,
      }
      const change: ChangeItem = {
        seq: 2,
        file_id: 'sample',
        version_id: 'incoming',
        path: 'new.md',
        prev_path: 'old.md',
        op: 'move',
        sha,
        size: bytes.length,
        mtime: 1000,
        kind: 'note',
        at: '',
        actor: { kind: 'system', id: 'sample', name: 'Sample' },
      }
      await fs.writeAtomic('old.md', bytes, 1000)
      await state.put(base)
      await state.setCursor(1)
      const stage = await fs.beginAtomicWrite('new.md', 1000, null)
      await stage.append(0, bytes)
      await stage.seal({ sha, size: bytes.length })
      await state.setMeta(
        'pull-write:sample',
        JSON.stringify({
          seq: 2,
          fileId: 'sample',
          versionId: 'incoming',
          wirePath: 'new.md',
          sha,
          size: bytes.length,
          mtime: 1000,
          target: 'new.md',
          from: 'old.md',
          base,
          stageId: stage.id,
          ...(recordedIdentity ? { sourceIdentity: await fs.fileIdentity('old.md') } : {}),
        })
      )
      await fs.remove('old.md')
      await fs.writeAtomic('old.md', bytes, 1000)
      const instrument = () => {
        const reopen = fs.reopenStage.bind(fs)
        fs.reopenStage = async (id) => {
          const handle = await reopen(id)
          handle.installed = async () => false
          handle.commit = async () => {
            throw new EngineError('conflict', 'not authorized')
          }
          return handle
        }
      }
      instrument()
      const client = {
        changes: async () => ({ items: [change], head_seq: 2, next_since: 2 }),
        getBlob: async () => bytes,
        ...(streaming
          ? {
              openVersion: async () => ({
                size: bytes.length,
                read: async (at: number, length: number) => bytes.slice(at, at + length),
                assertUnchanged: async () => {},
                close: async () => {},
              }),
            }
          : {}),
      } as unknown as EngineClient
      const run = () =>
        pull(client, fs, state, {
          dirty: new Set(),
          expected: new ExpectedWrites(),
          filter: { excluded: () => false },
        })
      const start = scheduler.points.length
      scheduler.cut = cut
      try {
        await run()
      } catch (error) {
        if (!(error instanceof EpochError) || !cut) throw error
      }
      const points = scheduler.points.slice(start)
      if (cut) {
        expect(scheduler.epoch).toBe(1)
        scheduler.cut = undefined
        fs = fs.reopen()
        state = state.reopen()
        instrument()
      }
      const result = await run()
      expect(result.applied).toBe(0)
      expect(result.held).toHaveLength(1)
      expect(fs.snapshot().get('old.md')).toEqual(bytes)
      expect(fs.snapshot().has('new.md')).toBe(false)
      expect(await state.byFileId('sample')).toEqual(base)
      expect(JSON.parse((await state.getMeta('pull-write:sample'))!).stageId).toBe(stage.id)
      expect(fs.stages.has(stage.id)).toBe(true)
      return points
    }
    for (const cut of await execute()) await execute(cut)
  },
  20000
)
