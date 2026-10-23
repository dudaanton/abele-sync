import { describe, expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import {
  applyStaged,
  pull,
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
import { PendingPullWrites } from '../../src/pullWrite.js'

async function fixture(seed: number) {
  const scheduler = new SimScheduler(seed)
  let fs = new MemoryStreamingFS(scheduler),
    state = new DurableStateStore(scheduler),
    refusing = true,
    excluded: (path: string) => boolean = () => false
  const bytes = new TextEncoder().encode('incoming'),
    sha = await sha256(bytes),
    removals = new Map<string, number>()
  const downloads: string[] = []
  const client = {
    openVersion: async (_fileId: string, versionId: string) => {
      downloads.push(versionId)
      return {
        size: bytes.length,
        read: async (at: number, length: number) => bytes.slice(at, at + length),
        assertUnchanged: async () => {},
        close: async () => {},
      }
    },
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
  const staging = (deferred = true) =>
    new Staging({
      client,
      fs,
      state,
      filter: { excluded: (path) => excluded(path) },
      expected: new ExpectedWrites(),
      defer: deferred ? () => true : undefined,
      log: () => {},
    })
  const run = (item: ChangeItem, respectScope = false) =>
    applyStaged(client, fs, state, [item], {
      dirty: new Set(),
      expected: new ExpectedWrites(),
      filter: { excluded: (path) => respectScope && excluded(path) },
      prefetchBytes: 0,
    })
  const replayExcluded = (item: ChangeItem) =>
    pull(
      {
        ...client,
        manifest: async () => ({
          items: [{ ...item, sha: item.sha!, size: item.size!, mtime: item.mtime! }],
          next: null,
          head_seq: item.seq,
        }),
        changes: async (since: number) => ({
          items: item.seq > since ? [item] : [],
          head_seq: item.seq,
          next_since: item.seq,
        }),
      } as EngineClient,
      fs,
      state,
      {
        dirty: new Set(),
        expected: new ExpectedWrites(),
        filter: { excluded: (path) => excluded(path) },
        prefetchBytes: 0,
      }
    )
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
    downloads,
    bytes,
    sha,
    change,
    staging,
    run,
    replayExcluded,
    retain,
    recover,
    allow: () => {
      refusing = false
    },
    include: () => {
      excluded = () => false
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

it.each(['drop', 'replace', 'exclude', 'pull-exclude', 'new-head'] as const)(
  'a retired decision cannot return after a disk-only restart (%s)',
  async (mode) => {
    async function execute(recoveryCut?: string) {
      const f = await fixture(192),
        id = await f.retain('a')
      f.scheduler.cut = 'stage.discarded#1'
      const operation =
        mode === 'replace'
          ? f.staging().stage([{ change: f.change('a', 2), base: null }])
          : mode === 'exclude'
            ? (f.exclude(), f.staging().tidy(new Set()))
            : mode === 'pull-exclude'
              ? (f.exclude(), f.replayExcluded(f.change('a')))
              : mode === 'new-head'
                ? f.run(f.change('a', 2))
                : f.staging().records.drop(['a'])
      await expect(operation).rejects.toBeInstanceOf(EpochError)
      f.reopen()
      f.allow()
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
      expect(f.fs.stages.has(id)).toBe(false)
      expect(await f.state.getMeta('pull-write:a')).toBeNull()
      expect(await f.staging().list()).toEqual(mode === 'replace' ? [f.change('a', 2)] : [])
      f.include()
      const before = f.fs.snapshot(),
        downloads = f.downloads.length
      expect((await f.staging().apply(new Set(), new Set(['a-1']))).applied).toEqual([])
      expect(f.fs.snapshot()).toEqual(before)
      await f.staging(false).tidy(new Set())
      expect(f.downloads.slice(downloads)).not.toContain('a-1')
      expect(f.removals.get(id)).toBe(1)
      return points
    }
    for (const recoveryCut of await execute()) await execute(recoveryCut)
  }
)

it('a live staged reader observes revocation by a newer remote head', async () => {
  const f = await fixture(192),
    id = await f.retain('a'),
    staging = f.staging()
  expect(await staging.list()).toEqual([f.change('a')])
  await f.run(f.change('a', 2))
  expect(f.fs.stages.has(id)).toBe(false)
  expect(await staging.list()).toEqual([])
  await staging.stage([{ change: f.change('a', 2), base: null }])
  await staging.records.drop(['a'])
})

it('cleanup without a committed retirement leaves the held decision and bytes owned', async () => {
  const f = await fixture(196),
    id = await f.retain('a')
  const pending = new PendingPullWrites(f.state, f.fs)
  await pending.finishRetirement(f.change('a'))
  expect(f.fs.stages.has(id)).toBe(true)
  expect(await f.staging().list()).toEqual([f.change('a')])
  expect(f.removals.get(id)).toBeUndefined()
  await pending.retireDecision(f.change('a'))
  expect(f.fs.stages.has(id)).toBe(false)
  expect(await f.staging().list()).toEqual([])
  expect(await f.state.getMeta('pull-write:a')).toBeNull()
  expect(f.removals.get(id)).toBe(1)
})

it('a replacement batch keeps the held bytes of its final decision', async () => {
  const f = await fixture(196),
    id = await f.retain('a')
  await f.staging().stage([
    { change: f.change('a', 2), base: null },
    { change: f.change('a'), base: null },
  ])
  expect(await f.staging().list()).toEqual([f.change('a')])
  expect(f.fs.stages.has(id)).toBe(true)
  expect(f.removals.get(id)).toBeUndefined()
  f.allow()
  const downloads = f.downloads.length
  expect((await f.staging().apply(new Set())).applied).toEqual(['a.bin'])
  expect(f.downloads.length).toBe(downloads)
  expect(f.removals.get(id)).toBe(1)
})

it('an excluded old replay cannot retire a newer held decision', async () => {
  const f = await fixture(196)
  await f.retain('a')
  await f.run(f.change('a', 2))
  await f.staging().stage([{ change: f.change('a', 2), base: null }])
  const pending = await f.state.getMeta('pull-write:a')
  const id = JSON.parse(pending!).stageId
  f.exclude()
  const downloads = f.downloads.length,
    before = f.fs.snapshot()
  await f.run(f.change('a'), true)
  expect(await f.state.getMeta('pull-write:a')).toBe(pending)
  expect(await f.staging().list()).toEqual([f.change('a', 2)])
  expect(f.fs.stages.has(id)).toBe(true)
  expect(f.fs.snapshot()).toEqual(before)
  expect(f.downloads.slice(downloads)).toEqual([])
  await f.staging().records.drop(['a'])
  expect(f.removals.get(id)).toBe(1)
})

it('byte-limit eviction keeps the unresolved decision retryable', async () => {
  const f = await fixture(192),
    id = await f.retain('a')
  await new PendingPullWrites(f.state, f.fs).retain('a', { count: 0, bytes: 0 })
  expect(f.fs.stages.has(id)).toBe(false)
  expect(await f.staging().list()).toEqual([f.change('a')])
  f.reopen()
  f.allow()
  await f.recover()
  expect((await f.staging().apply(new Set())).applied).toEqual(['a.bin'])
  expect(f.fs.snapshot().get('a.bin')).toEqual(f.bytes)
})

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
describe.each([187, 188, 189, 190])(
  'retained bytes never outlive random decision endings (seed %s)',
  (seed) => {
    const random = new SimScheduler(seed),
      endings = [
        'apply',
        'exclude',
        'pull-exclude',
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
        } else if (mode === 'pull-exclude') {
          f.exclude(`${id}.bin`)
          await f.replayExcluded(f.change(id))
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
      try {
        for (let n = 0; n < endings.length; n++) await finish(n)
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
        await f.staging().afterPull()
        // Restart from durable state only. Never replay the interrupted host
        // decision using a remembered next index or finish(next).
        const decisions = await f.staging().list()
        const retired = new Set<string>()
        for (const [fileId, stageId] of originals) {
          if (f.fs.stages.has(stageId)) continue
          retired.add(fileId + '-1')
          expect(decisions.find((item) => item.file_id === fileId)?.version_id).not.toBe(
            fileId + '-1'
          )
        }
        await assertOwnership()
        f.allow()
        const before = f.fs.snapshot(),
          downloads = f.downloads.length
        expect((await f.staging().apply(new Set(), retired)).applied).toEqual([])
        expect(f.fs.snapshot()).toEqual(before)
        expect(f.downloads.slice(downloads).some((version) => retired.has(version))).toBe(false)
        // A new, explicit teardown decision operates only on records read back
        // from disk; it cannot hide resurrection checked above.
        await f.staging().records.drop((await f.staging().list()).map((item) => item.file_id))
      }
      await f.recover()
      await assertOwnership()
      expect(f.fs.stages.size).toBe(0)
      for (const id of originals.values()) expect(f.removals.get(id)).toBe(1)
      expect(f.removals.get(teardownStage)).toBe(1)
      return points
    }
    let points: string[] | undefined
    it.each(Array.from({ length: 32 }, (_, n) => n))(
      'cuts shard %i (at most 64)',
      async (shard) => {
        if (!points) {
          points = await execute()
          console.info(`heldStageEndings seed ${seed}: ${points.length} crash cuts`)
        }
        expect(points.length).toBeLessThanOrEqual(32 * 64)
        for (const cut of points.slice(shard * 64, (shard + 1) * 64)) await execute(cut)
      },
      20000
    )
  }
)
