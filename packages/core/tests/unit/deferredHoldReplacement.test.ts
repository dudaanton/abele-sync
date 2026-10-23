import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import {
  MemoryStateStore,
  MemoryFileSystem,
  ExpectedWrites,
  StagedChanges,
  pull,
  type EngineClient,
} from '../../src/index.js'
import { PendingPullWrites } from '../../src/pullWrite.js'

const change = (
  id: string,
  version = 'v1',
  path = `safe/${id}`,
  prev_path: string | null = null
): ChangeItem => ({
  seq: version === 'v1' ? 1 : 2,
  file_id: id,
  version_id: version,
  path,
  prev_path,
  op: prev_path ? 'move' : 'modify',
  kind: 'attachment',
  sha: null,
  size: null,
  mtime: null,
  actor: { kind: 'system', id: 'test', name: 'test' },
  at: '',
})
async function fixture() {
  const state = new MemoryStateStore(),
    staged = new StagedChanges(state)
  await staged.stage([
    { change: change('h', 'v1', 'held/h'), base: null },
    { change: change('b'), base: null },
  ])
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: [],
      removals: [],
      refused: [
        {
          path: 'held',
          code: 'conflict',
          message: 'held directory',
          direction: 'push',
          evidence: true,
        },
      ],
    })
  )
  return { state, staged }
}
it('D-211 unchanged held decisions do not suppress unrelated replacements and additions', async () => {
  const { state, staged } = await fixture()
  expect(
    await staged.stage([
      { change: change('b', 'v2'), base: null },
      { change: change('c'), base: null },
    ])
  ).toBe(2)
  expect(
    (await new StagedChanges(state).list()).map((row) => [
      row.change.file_id,
      row.change.version_id,
    ])
  ).toEqual([
    ['h', 'v1'],
    ['c', 'v1'],
    ['b', 'v2'],
  ])
})
it('D-211 a refused retirement reports failure while saving unrelated decisions', async () => {
  const { state, staged } = await fixture()
  await expect(
    staged.stage([
      { change: change('h', 'v2', 'held/h'), base: null },
      { change: change('b', 'v2'), base: null },
      { change: change('c'), base: null },
    ])
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(
    (await new StagedChanges(state).list()).map((row) => [
      row.change.file_id,
      row.change.version_id,
    ])
  ).toEqual([
    ['h', 'v1'],
    ['c', 'v1'],
    ['b', 'v2'],
  ])
  await state.setMeta('v2-directories', JSON.stringify({ directories: [], removals: [] }))
  expect(await staged.stage([{ change: change('h', 'v2', 'held/h'), base: null }])).toBe(1)
  expect((await new StagedChanges(state).list()).map((row) => row.change.version_id)).toEqual([
    'v1',
    'v2',
    'v2',
  ])
})

it('a mixed drop reports its held decision and still retires unrelated decisions', async () => {
  const { state, staged } = await fixture()
  await expect(staged.drop(['h', 'b'])).rejects.toMatchObject({ code: 'conflict' })
  expect((await new StagedChanges(state).list()).map((row) => row.change.file_id)).toEqual(['h'])
})

it('D-211 pull acknowledges only durably saved unrelated deferred updates', async () => {
  const { state, staged } = await fixture()
  await state.setCursor(1)
  const updates = [change('b', 'v2'), { ...change('c'), seq: 3 }]
  const client = {
    changes: async () => ({ items: updates, head_seq: 3, next_since: 3 }),
  } as unknown as EngineClient
  await pull(client, new MemoryFileSystem(), state, {
    expected: new ExpectedWrites(),
    dirty: new Set(),
    filter: { excluded: () => false },
    defer: () => true,
    onDefer: (items) => staged.stage(items),
  })
  expect(await state.getCursor()).toBe(3)
  expect(
    (await new StagedChanges(state).list()).map((row) => [
      row.change.file_id,
      row.change.version_id,
    ])
  ).toEqual([
    ['h', 'v1'],
    ['b', 'v2'],
    ['c', 'v1'],
  ])
})
it.each(['destination', 'source'] as const)(
  'D-212 retirement checks deferred %s even with a safe ledger row',
  async (side) => {
    const { state } = await fixture()
    await state.put({
      fileId: 'f',
      versionId: 'v1',
      path: 'safe/a',
      wirePath: 'safe/a',
      sha: 'a'.repeat(64),
      size: 1,
      mtime: 1,
    })
    const move = change(
      'f',
      'v2',
      side === 'destination' ? 'held/a' : 'safe/new',
      side === 'source' ? 'held/a' : 'safe/a'
    )
    const staged = new StagedChanges(state)
    await staged.stage([{ change: move, base: 'v1' }])
    const before = await state.getMeta('deferred-changes')
    const result = await new PendingPullWrites(state).retireDecision(move)
    expect(await state.getMeta('deferred-changes')).toBe(before)
    expect(result).toMatchObject({ held: [{ file_id: 'f', version_id: 'v2' }] })
  }
)
