import { expect, it } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites } from '../../src/index.js'
import type { StateStore } from '../../src/state.js'
import type { EngineClient } from '../../src/engineClient.js'
import { importLegacyPullHolds, PullHolds } from '../../src/pullHolds.js'
import { pull } from '../../src/puller.js'
import { change } from './holdFixture.js'

// Historical writers: 679d817 (firstHeld only), 0fbe444 (split payload),
// 64c4ad6 (heldBases), 1aac759/8e19387 (zero/real-head arrays), 765d093 (linked).
// Inline payloads are also accepted by the historical checkpoint reader.
const shapes = [
  'neither',
  'pointer-only',
  'payload',
  'shadowed-payload',
  'inline',
  'bases',
  'array',
  'array-real-head',
  'array-no-checkpoint',
  'both',
  'array-inline',
  'all',
  'linked',
  'linked-zero-head',
  'linked-payload',
] as const
const rows = shapes.flatMap((shape) =>
  [false, true].flatMap((complete) => [false, true].map((rewind) => ({ shape, complete, rewind })))
)

type Row = (typeof rows)[number]
async function fixture({ shape, complete }: Row) {
  const state = new MemoryStateStore(),
    a = await change(49),
    b = await change(59)
  const newerA = { ...a, seq: 70, version_id: 'v70' }
  const expected =
    shape === 'neither'
      ? []
      : shape === 'all'
        ? [newerA, b]
        : [
              'pointer-only',
              'payload',
              'shadowed-payload',
              'inline',
              'bases',
              'both',
              'array-inline',
              'linked-payload',
            ].includes(shape)
          ? [a, b]
          : [a]
  for (const item of expected)
    await state.put({
      path: item.path,
      wirePath: item.path,
      fileId: item.file_id,
      versionId: 'base',
      sha: item.sha!,
      size: 1,
      mtime: 1,
    })
  const payload =
    shape === 'payload' || shape === 'shadowed-payload' || shape === 'bases'
      ? [a, b]
      : ['both', 'all', 'linked-payload'].includes(shape)
        ? [b]
        : []
  const inline =
    shape === 'inline'
      ? [a, b]
      : shape === 'shadowed-payload'
        ? []
        : shape === 'array-inline'
          ? [b]
          : shape === 'all'
            ? [newerA]
            : undefined
  const header = {
    head: 100,
    completed: shape === 'pointer-only' ? [b.file_id] : [],
    seen: [],
    recheck: [],
    firstHeld: shape === 'pointer-only' ? 50 : null,
    coverageComplete: complete,
    heldChanges: inline,
    ...(shape === 'pointer-only' ? {} : { generation: null, scope: null }),
    ...(shape === 'bases' ? { heldBases: { [a.file_id]: null, [b.file_id]: 'stale' } } : {}),
  }
  if (shape !== 'array-no-checkpoint') {
    await state.setMeta('pull-manifest-progress', JSON.stringify(header))
    await state.setMeta(
      'pull-manifest-page',
      JSON.stringify({
        items: shape === 'pointer-only' ? [b] : expected,
        head_seq: 100,
        next: complete ? null : 'later',
        heldChanges: payload,
        seen: [],
        recheck: [],
      })
    )
  }
  if (
    ['array', 'array-real-head', 'array-no-checkpoint', 'both', 'array-inline', 'all'].includes(
      shape
    )
  ) {
    await state.setMeta(
      'pull-held-progress',
      JSON.stringify({
        generation: null,
        head: complete || shape === 'array-no-checkpoint' || shape === 'array-real-head' ? 100 : 0,
        inventoryComplete: complete,
        holds: [{ change: a, base: 'base', firstSeq: 50 }],
      })
    )
  } else if (shape.startsWith('linked')) {
    const holds = new PullHolds(state)
    await holds.load()
    holds.put({ change: a, base: 'base', firstSeq: 50 })
    await state.transaction((tx) => holds.persist(100, complete, tx))
    if (shape === 'linked-zero-head' && !complete) {
      const header = JSON.parse((await state.getMeta('pull-held-progress'))!)
      await state.setMeta('pull-held-progress', JSON.stringify({ ...header, head: 0 }))
    }
  }
  await state.setCursor(complete ? 49 : 0)
  const followed: number[] = []
  const client = {
    manifest: async () => ({ items: expected, head_seq: 100, next: null }),
    changes: async (since: number) => {
      followed.push(since)
      return {
        items: since < 100 ? expected.filter((item) => item.seq > since) : [],
        head_seq: 100,
        next_since: 100,
      }
    },
  } as unknown as EngineClient
  return { state, client, expected, followed }
}

/** Fail after each awaited state/client operation, including after transaction commit. */
function faults(state: StateStore, client: EngineClient, cut: number) {
  let count = 0
  const restores: (() => void)[] = []
  const wrap = (target: object, key: string) => {
    const object = target as Record<string, (...args: unknown[]) => unknown>
    const original = object[key]!
    object[key] = async (...args) => {
      if (key === 'transaction') {
        const work = args[0] as (tx: StateStore) => Promise<unknown>
        args[0] = (tx: StateStore) => {
          for (const method of ['getMeta', 'setMeta', 'byFileId', 'transaction']) wrap(tx, method)
          return work(tx)
        }
      }
      const result = await original.apply(target, args)
      if (++count === cut) throw new Error('migration crash')
      return result
    }
    restores.push(() => {
      object[key] = original
    })
  }
  for (const method of ['getMeta', 'setMeta', 'byFileId', 'transaction']) wrap(state, method)
  wrap(client, 'changes')
  return { count: () => count, restore: () => restores.forEach((restore) => restore()) }
}

it.each(rows)(
  'migrates $shape, complete=$complete, rewind=$rewind through every migration crash',
  async (row) => {
    const baseline = await fixture(row)
    const trace = faults(baseline.state, baseline.client, -1)
    await importLegacyPullHolds(baseline.state, baseline.client)
    const steps = trace.count()
    trace.restore()
    for (let cut = 0; cut <= steps; cut++) {
      const { state, client, expected, followed } = await fixture(row)
      const injection = faults(state, client, cut)
      try {
        await importLegacyPullHolds(state, client)
        if (cut > 0) throw new Error(`missed migration crash ${cut}`)
      } catch (error) {
        expect((error as Error).message, `cut ${cut}`).toBe('migration crash')
      } finally {
        injection.restore()
      }
      // A failed migration aborts the cycle, so rewind only follows a successful retry.
      await importLegacyPullHolds(state, client)
      if (expected.length)
        expect(JSON.parse((await state.getMeta('pull-held-progress'))!).format, `cut ${cut}`).toBe(
          2
        )
      if (row.rewind)
        await state.transaction(async (tx) => {
          await tx.setCursor(0)
          await tx.setMeta!('pull-manifest-progress', null)
          await tx.setMeta!('pull-manifest-page', null)
        })
      const paths = new Set(expected.map((item) => item.path))
      const report = await pull(client, new MemoryFileSystem(), state, {
        dirty: paths,
        noted: paths,
        expected: new ExpectedWrites(),
        filter: { excluded: () => false },
      })
      expect(report.held.map((item) => item.version_id).sort(), `cut ${cut}`).toEqual(
        expected.map((item) => item.version_id).sort()
      )
      expect(followed.length, `cut ${cut}`).toBeGreaterThan(0)
      expect(
        followed.every((since) => since >= 49),
        `cut ${cut}: replay from zero`
      ).toBe(true)
      if (expected.length) expect(report.cursor, `cut ${cut}`).toBeLessThan(50)
      const durable = new PullHolds(state)
      await durable.load()
      expect(durable.files.size, `cut ${cut}`).toBe(expected.length)
      expect(
        [...durable.records.values()].every((record) => record.base === 'base'),
        `cut ${cut}: base lost`
      ).toBe(true)
      expect(state.metadataKeys('pull-held:'), `cut ${cut}: leaked records`).toHaveLength(
        expected.length
      )
    }
  },
  30000
)
