import { expect, it } from 'vitest'
import {
  pull,
  recoverPendingPullWrites,
  scan,
  ExpectedWrites,
  EngineError,
  sha256,
  type EngineClient,
} from '../../src/index.js'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { DurableStateStore } from './durableState.js'
import { SimScheduler, EpochError } from './scheduler.js'

it.each([
  [false, false, false, true],
  [true, false, false, true],
  [false, true, false, true],
  [true, true, false, true],
  [false, false, true, true],
  [true, false, true, true],
  [false, true, true, true],
  [true, true, true, true],
  [true, true, true, false],
  [true, false, false, false, true, true],
  [true, false, false, false, true, false],
])(
  'pending private stage never claims a recreated source (streaming=%s, identity=%s, case-only=%s, capability=%s, unsealable=%s, same-bytes=%s)',
  async (
    streaming,
    recordedIdentity,
    caseOnly,
    capability,
    unsealable = false,
    sameBytes = true
  ) => {
    const from = caseOnly ? 'Note.md' : 'old.md',
      to = caseOnly ? 'note.md' : 'new.md'
    const bytes = new TextEncoder().encode('sample A'),
      sha = await sha256(bytes)
    async function execute(cut?: string) {
      const scheduler = new SimScheduler(186)
      let fs = new MemoryStreamingFS(scheduler),
        state = new DurableStateStore(scheduler)
      const base = {
        path: from,
        wirePath: from,
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
        path: to,
        prev_path: from,
        op: 'move',
        sha,
        size: bytes.length,
        mtime: 1000,
        kind: 'note',
        at: '',
        actor: { kind: 'system', id: 'sample', name: 'Sample' },
      }
      await fs.writeAtomic(from, bytes, 1000)
      await state.put(base)
      await state.setCursor(1)
      const stage = await fs.beginAtomicWrite(to, 1000, null)
      await stage.append(0, bytes)
      if (!unsealable) await stage.seal({ sha, size: bytes.length })
      await state.setMeta(
        'pull-write:sample',
        JSON.stringify({
          seq: 2,
          fileId: 'sample',
          versionId: 'incoming',
          wirePath: to,
          sha,
          size: bytes.length,
          mtime: 1000,
          target: to,
          from: from,
          base,
          stageId: stage.id,
          ...(recordedIdentity ? { sourceIdentity: await fs.fileIdentity(from) } : {}),
        })
      )
      const recreated = sameBytes ? bytes : new Uint8Array(bytes.length).fill(9)
      await fs.remove(from)
      await fs.writeAtomic(from, recreated, 1000)
      if (unsealable) {
        fs = fs.reopen()
        state = state.reopen()
      }
      const instrument = () => {
        if (!capability) Object.defineProperty(fs, 'fileIdentity', { value: undefined })
        const reopen = fs.reopenStage.bind(fs)
        fs.reopenStage = async (id) => {
          const handle = await reopen(id)
          if (unsealable)
            handle.seal = async () => {
              await scheduler.point('stage.unavailableVerification')
              throw new EngineError(
                'conflict',
                'Existing bytes require bounded local verification; file kept'
              )
            }
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
      expect(fs.snapshot().get(from)).toEqual(recreated)
      expect(fs.snapshot().has(to)).toBe(false)
      expect(await state.byFileId('sample')).toEqual(base)
      expect(JSON.parse((await state.getMeta('pull-write:sample'))!)).toMatchObject({
        stageId: stage.id,
        ...(unsealable ? {} : { heldOrder: expect.any(Number) }),
      })
      expect(fs.stages.has(stage.id)).toBe(true)
      if (unsealable) {
        expect(fs.stages.get(stage.id)?.sealed).toBe(false)
        expect(fs.stages.get(stage.id)?.bytes).toEqual(bytes)
        expect(JSON.parse((await state.getMeta('pull-write:sample'))!).heldOrder).toBeUndefined()
      }
      // Unverified evidence remains a recovery obligation, not a verified held cache.
      if (unsealable)
        await expect(recoverPendingPullWrites(fs, state, ['sample'], client)).rejects.toMatchObject(
          {
            reason: 'recovery-required',
          }
        )
      else await recoverPendingPullWrites(fs, state, ['sample'], client)
      expect(fs.snapshot().get(from)).toEqual(recreated)
      await fs.writeAtomic(from, new Uint8Array([9]), 1001)
      const found = await scan(fs, state, { excluded: () => false })
      expect(found.ops).not.toContainEqual(expect.objectContaining({ file_id: 'sample' }))
      return points
    }
    for (const cut of await execute()) await execute(cut)
  },
  20000
)
