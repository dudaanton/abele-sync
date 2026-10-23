import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import {
  applyStaged,
  EngineError,
  ExpectedWrites,
  recoverPendingPullWrites,
  sha256,
  StagedChanges,
  Staging,
  type EngineClient,
} from '../../src/index.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { EpochError, SimScheduler } from './scheduler.js'

async function fixture(seed: number) {
  const scheduler = new SimScheduler(seed)
  let fs = new MemoryStreamingFS(scheduler),
    state = new DurableStateStore(scheduler),
    refusing = true,
    excluded: (path: string) => boolean = () => false
  const bytes = new TextEncoder().encode('incoming'),
    sha = await sha256(bytes),
    removals = new Map<string, number>()
  const client = {
    openVersion: async () => ({
      size: bytes.length,
      read: async (at: number, length: number) => bytes.slice(at, at + length),
      assertUnchanged: async () => {},
      close: async () => {},
    }),
  } as unknown as EngineClient
  const instrument = () => {
    const begin = fs.beginAtomicWrite.bind(fs),
      reopen = fs.reopenStage.bind(fs),
      discard = fs.discardStage.bind(fs)
    const wrap = (stage: Awaited<ReturnType<typeof begin>>) => {
      const commit = stage.commit.bind(stage)
      stage.commit = async (signal) => {
        if (refusing) throw new EngineError('conflict', 'local save')
        await commit(signal)
      }
      return stage
    }
    fs.beginAtomicWrite = async (...args) => wrap(await begin(...args))
    fs.reopenStage = async (id) => wrap(await reopen(id))
    fs.discardStage = async (id) => {
      const existed = fs.stages.has(id)
      await discard(id)
      if (existed) removals.set(id, 1 + (removals.get(id) ?? 0))
      // Exercise the durable gap after bytes are gone, before ownership is cleared.
      await scheduler.point('stage.discarded')
    }
  }
  instrument()
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
  const staging = () =>
    new Staging({
      client,
      fs,
      state,
      filter: { excluded: (path) => excluded(path) },
      expected: new ExpectedWrites(),
      defer: () => true,
      log: () => {},
    })
  const run = (item: ChangeItem, respectScope = false) =>
    applyStaged(client, fs, state, [item], {
      dirty: new Set(),
      expected: new ExpectedWrites(),
      filter: { excluded: (path) => respectScope && excluded(path) },
      prefetchBytes: 0,
    })
  const retain = async (id: string, tracked = false, deferred = true) => {
    const item = change(id)
    if (tracked) {
      const old = new TextEncoder().encode('old')
      await fs.writeAtomic(item.path, old, 1)
      await state.put({
        path: item.path,
        wirePath: item.path,
        fileId: id,
        versionId: `${id}-base`,
        sha: await sha256(old),
        size: old.length,
        mtime: 1,
      })
      item.op = 'modify'
    }
    expect((await run(item)).held).toEqual([item])
    if (deferred)
      await staging().stage([{ change: item, base: (await state.byFileId(id))?.versionId ?? null }])
    return JSON.parse((await state.getMeta(`pull-write:${id}`))!).stageId as string
  }
  const recover = async () =>
    recoverPendingPullWrites(
      fs,
      state,
      (await state.metadataKeys('pull-write:')).map((key) => key.slice('pull-write:'.length)),
      client
    )
  return {
    scheduler,
    get fs() {
      return fs
    },
    get state() {
      return state
    },
    removals,
    bytes,
    sha,
    change,
    staging,
    run,
    retain,
    recover,
    allow: () => {
      refusing = false
    },
    exclude: (path?: string) => {
      excluded = (candidate) => path === undefined || path === candidate
    },
    reopen: () => {
      scheduler.cut = undefined
      fs = fs.reopen()
      state = state.reopen()
      instrument()
    },
  }
}

it('scope narrowing retires refused bytes before dropping their deferred decision', async () => {
  const f = await fixture(187),
    id = await f.retain('a')
  f.exclude()
  await f.staging().tidy(new Set())
  await f.recover()
  expect(await f.staging().list()).toEqual([])
  expect(await f.state.getMeta('pull-write:a')).toBeNull()
  expect(f.fs.stages.has(id)).toBe(false)
  expect(f.removals.get(id)).toBe(1)
})

it.each([false, true])(
  'scope narrowing also resolves an ordinary held pull (tracked=%s)',
  async (tracked) => {
    async function execute(cut?: string) {
      const f = await fixture(187),
        id = await f.retain('a', tracked, false)
      const before = f.fs.snapshot()
      f.exclude()
      const start = f.scheduler.points.length
      f.scheduler.cut = cut
      try {
        await f.run(f.change('a'), true)
      } catch (error) {
        if (!(error instanceof EpochError) || !cut) throw error
      }
      const points = f.scheduler.points.slice(start)
      if (cut) {
        expect(f.scheduler.epoch, cut).toBe(1)
        f.reopen()
        await f.recover()
        await f.run(f.change('a'), true)
      }
      await f.recover()
      expect(await f.state.getMeta('pull-write:a')).toBeNull()
      expect(f.fs.stages.has(id)).toBe(false)
      expect(f.removals.get(id)).toBe(1)
      expect(f.fs.snapshot()).toEqual(before)
      return points
    }
    for (const cut of await execute()) await execute(cut)
  }
)

it.each(['fs.stage.discard#1', 'stage.discarded#1'])(
  'recovery retires a completed held installation without another pull (%s)',
  async (cut) => {
    async function execute(recoveryCut?: string) {
      const f = await fixture(188),
        id = await f.retain('a')
      f.allow()
      f.scheduler.cut = cut
      await expect(f.staging().apply(new Set())).rejects.toBeInstanceOf(EpochError)
      f.reopen()
      expect(await f.state.byFileId('a')).toMatchObject({ versionId: 'a-1', sha: f.sha })
      expect(JSON.parse((await f.state.getMeta('pull-write:a'))!).heldOrder).toBeDefined()
      const start = f.scheduler.points.length
      f.scheduler.cut = recoveryCut
      try {
        await f.recover()
      } catch (error) {
        if (!(error instanceof EpochError) || !recoveryCut) throw error
      }
      const points = f.scheduler.points.slice(start)
      if (recoveryCut) {
        expect(f.scheduler.epoch, recoveryCut).toBe(2)
        f.reopen()
        await f.recover()
      }
      // No replay of apply: recovery alone must finish ownership cleanup.
      expect(await f.state.getMeta('pull-write:a')).toBeNull()
      expect(f.fs.stages.has(id)).toBe(false)
      expect(f.removals.get(id)).toBe(1)
      expect(f.fs.snapshot().get('a.bin')).toEqual(f.bytes)
      return points
    }
    for (const recoveryCut of await execute()) await execute(recoveryCut)
  }
)

it('a metadata-only caller cannot abandon bytes it has no filesystem authority to retire', async () => {
  const f = await fixture(187),
    id = await f.retain('a'),
    records = new StagedChanges(f.state)
  await expect(records.drop(['a'])).rejects.toThrow('without its filesystem')
  await expect(records.stage([{ change: f.change('a', 2), base: null }])).rejects.toThrow(
    'without its filesystem'
  )
  expect(await records.list()).toMatchObject([{ change: { version_id: 'a-1' } }])
  expect(f.fs.stages.has(id)).toBe(true)
  await f.staging().records.drop(['a'])
  expect(f.removals.get(id)).toBe(1)
})

// Each seed permutes terminal decisions on independent files. Every boundary
// in both the decision and recovery is replayed with a fresh process epoch.
it.each([187, 188, 189, 190])(
  'retained bytes never outlive random decision endings (seed %s)',
  async (seed) => {
    const random = new SimScheduler(seed),
      endings = [
        'apply',
        'exclude',
        'keep',
        'discard',
        'supersede',
        'delete',
        'move',
        'push-delete',
        'push-move',
      ]
        .map((mode) => ({ mode, order: random.random() }))
        .sort((a, b) => a.order - b.order)
        .map(({ mode }) => mode)
    async function execute(cut?: string) {
      const f = await fixture(seed),
        originals = new Map<string, string>()
      for (let n = 0; n < endings.length; n++) originals.set(`f${n}`, await f.retain(`f${n}`, true))
      const teardownStage = await f.retain('teardown')
      const assertOwnership = async () => {
        const decisions = new Map((await f.staging().list()).map((item) => [item.file_id, item]))
        const owned = new Set<string>()
        for (const key of await f.state.metadataKeys('pull-write:')) {
          const pending = JSON.parse((await f.state.getMeta(key))!)
          expect(pending.retiring).not.toBe(true)
          expect(decisions.get(pending.fileId)?.version_id).toBe(pending.versionId)
          expect(f.fs.stages.has(pending.stageId)).toBe(true)
          owned.add(pending.stageId)
        }
        expect(owned).toEqual(new Set(f.fs.stages.keys()))
        for (const count of f.removals.values()) expect(count).toBe(1)
      }
      const finish = async (n: number) => {
        const id = `f${n}`,
          mode = endings[n],
          item = f.change(id, 2)
        if (mode === 'apply') {
          f.allow()
          await f.staging().apply(new Set(), new Set([`${id}-1`]))
        } else if (mode === 'exclude') {
          // Exclude only this file; unaffected decisions keep their stages.
          f.exclude(`${id}.bin`)
          await f.staging().tidy(new Set())
        } else if (mode === 'keep') {
          await f.fs.writeAtomic(`${id}.bin`, new Uint8Array([42]), 2)
          await f.staging().keep(new Set([`${id}.bin`]))
        } else if (mode === 'supersede') {
          // A newer staged head (e.g. a push verdict) replaces the old decision
          // without downloading or applying its bytes.
          await f.staging().stage([{ change: item, base: `${id}-base` }])
        } else if (mode === 'discard') {
          await f.staging().records.drop([id])
        } else if (mode === 'delete' || mode === 'move') {
          f.allow()
          if (mode === 'delete')
            Object.assign(item, { op: 'delete', sha: null, size: null, mtime: null })
          else Object.assign(item, { op: 'move', prev_path: `${id}.bin`, path: `${id}-moved.bin` })
          await f.run(item)
          await f.staging().afterPull()
        } else {
          if (mode === 'push-delete') {
            await f.fs.remove(`${id}.bin`)
            await f.state.delete(`${id}.bin`)
          }
          if (mode === 'push-move') {
            if (await f.fs.stat(`${id}.bin`)) await f.fs.move(`${id}.bin`, `${id}-local.bin`)
            await f.state.delete(`${id}.bin`)
            await f.state.put({
              path: `${id}-local.bin`,
              wirePath: `${id}-local.bin`,
              fileId: id,
              versionId: `${id}-local`,
              sha: f.sha,
              size: f.bytes.length,
              mtime: 2,
            })
          }
          await f.staging().afterPush([
            mode === 'push-delete'
              ? { op: 'delete', file_id: id, base_version_id: `${id}-1` }
              : {
                  op: 'move',
                  file_id: id,
                  base_version_id: `${id}-1`,
                  to_path: `${id}-local.bin`,
                },
          ])
        }
        await f.recover()
        await f.staging().afterPull()
        expect(f.fs.stages.has(originals.get(id)!), mode).toBe(false)
        await assertOwnership()
      }
      const start = f.scheduler.points.length
      f.scheduler.cut = cut
      let next = 0
      try {
        for (; next < endings.length; next++) await finish(next)
        // Host connection teardown releases its remaining deferred decisions
        // through the same filesystem-aware ownership boundary, before state removal.
        await f.staging().records.drop((await f.staging().list()).map((item) => item.file_id))
      } catch (error) {
        if (!(error instanceof EpochError) || !cut) throw error
      }
      const points = f.scheduler.points.slice(start)
      if (cut) {
        expect(f.scheduler.epoch, cut).toBe(1)
        f.reopen()
        await f.recover()
        // Recovery must retire committed installations even before replaying
        // the host's decision or observing any newer feed page.
        for (const key of await f.state.metadataKeys('pull-write:')) {
          const pending = JSON.parse((await f.state.getMeta(key))!)
          expect((await f.state.byFileId(pending.fileId))?.versionId).not.toBe(pending.versionId)
        }
        for (; next < endings.length; next++) await finish(next)
        await f.staging().records.drop((await f.staging().list()).map((item) => item.file_id))
      }
      await f.recover()
      await assertOwnership()
      expect(f.fs.stages.size).toBe(0)
      for (const id of originals.values()) expect(f.removals.get(id)).toBe(1)
      expect(f.removals.get(teardownStage)).toBe(1)
      return points
    }
    const points = await execute()
    console.info(`held-stage endings seed ${seed}: ${points.length} crash cuts`)
    for (const cut of points) await execute(cut)
  },
  20000
)
