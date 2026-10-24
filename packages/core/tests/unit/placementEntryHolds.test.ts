import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites, sha256 } from '../../src/index.js'
import { PullPlacer } from '../../src/pullPlace.js'
import { PendingPullWrites } from '../../src/pullWrite.js'
import { recoverPendingPullWrites } from '../../src/pullRecovery.js'
import { recoverPullEvictions } from '../../src/pullEvictions.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'

async function fixture(intent = true, live = false, retiring = false) {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1, 2, 3]),
    sha = await sha256(bytes)
  const entry = {
    path: 'held/a.bin',
    wirePath: 'held/a.bin',
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
    path: entry.path,
    prev_path: null,
    op: 'modify',
    kind: 'attachment',
    sha,
    size: 3,
    mtime: 1,
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  await fs.writeAtomic(entry.path, bytes, 1)
  await state.put(entry)
  const pending = new PendingPullWrites(state, fs)
  if (intent) await pending.prepare(change, entry, entry.path, null, 'stage', 'receipt')
  if (retiring)
    await state.setMeta(
      'pull-write:f',
      JSON.stringify({
        ...JSON.parse((await state.getMeta('pull-write:f'))!),
        retiring: true,
      })
    )
  await state.setMeta('pull-evict:f', JSON.stringify(entry))
  const refusal = {
    path: 'held',
    code: 'conflict' as const,
    message: 'directory held',
    direction: 'push' as const,
    evidence: true,
  }
  if (!live)
    await state.setMeta(
      'v2-directories',
      JSON.stringify({ directories: [], removals: [], refused: [refusal] })
    )
  const discard = vi.fn(async () => {})
  Object.assign(fs, { discardInstallation: discard, discardStage: discard })
  const client = {
    getBlob: vi.fn(async () => bytes),
    pathRefusal: live ? () => refusal : undefined,
  }
  const opts = {
    expected: new ExpectedWrites(),
    dirty: new Set<string>(),
    filter: { excluded: () => false },
    onApplied: vi.fn(),
  }
  const placer = new PullPlacer(client, fs, state, opts, sha256)
  const effects = [
    vi.spyOn(state, 'put'),
    vi.spyOn(state, 'delete'),
    vi.spyOn(state, 'setMeta'),
    vi.spyOn(state, 'transaction'),
    vi.spyOn(fs, 'conditionalFile'),
    discard,
    client.getBlob,
    opts.onApplied,
  ]
  return {
    fs,
    state,
    entry,
    change,
    pending: new PendingPullWrites(state, fs, true, client),
    placer,
    effects,
    bytes,
    opts,
    client,
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
// Adding a public method requires classifying and testing its effect boundary.
const placerEffects = {
  place: true,
  drop: true,
  adopt: true,
  adoptExisting: true,
  settled: true,
  edited: true,
} satisfies Record<
  Exclude<
    keyof PullPlacer,
    'pending' | 'lying' | 'targetOf' | 'matchesTarget' | 'refusal' | 'disbelieve'
  >,
  true
>
const pendingEffects = {
  prepare: true,
  settled: true,
  clear: true,
  superseded: true,
  retireDecision: true,
  retireDecisions: true,
  finishRetirement: true,
  recoverRetirement: true,
  publishCleanup: true,
  flushCleanup: true,
  recoverCleanup: true,
  retain: true,
} satisfies Record<
  Exclude<keyof PendingPullWrites, 'refused' | 'matching' | 'authorizes' | 'stageId' | 'receiptId'>,
  true
>
const entries: Record<string, (f: Fixture) => Promise<unknown>> = {
  place: (f) => f.placer.place(f.change, f.entry.sha, f.entry, new Map(), new Map()),
  drop: (f) => f.placer.drop(f.entry),
  dropChange: (f) => f.placer.drop(f.entry, { ...f.change, op: 'delete', sha: null }),
  adopt: (f) => f.placer.adopt(f.change, f.entry),
  adoptExisting: (f) => f.placer.adoptExisting(f.change, f.entry),
  settled: (f) => f.placer.settled(f.change),
  edited: (f) => f.placer.edited(f.entry),
  prepare: (f) => f.pending.prepare(f.change, f.entry, f.entry.path, null),
  pendingSettled: (f) =>
    f.pending.settled(f.change, async () => {
      throw new Error('discarded held stage')
    }),
  clear: (f) => f.pending.clear('f'),
  superseded: (f) => f.pending.superseded({ ...f.change, version_id: 'v3', seq: 3 }),
  retireDecision: (f) => f.pending.retireDecision(f.change),
  retireDecisions: (f) => f.pending.retireDecisions([f.change]),
  finishRetirement: (f) => f.pending.finishRetirement(f.change),
  recoverRetirement: async (f) =>
    f.pending.recoverRetirement('f', (await f.state.getMeta('pull-write:f'))!),
  retain: (f) => f.pending.retain('f', { count: 0, bytes: 0 }),
  publishCleanup: (f) => f.pending.publishCleanup(f.state, f.change),
  flushCleanup: (f) => f.pending.flushCleanup(),
  recoverCleanup: (f) => f.pending.recoverCleanup(),
  recoverPending: (f) => recoverPendingPullWrites(f.fs, f.state, ['f'], f.client),
  recoverEvictions: (f) => recoverPullEvictions(f.fs, f.state, undefined, undefined, f.client),
}
it('covers every public effectful placer and intent method', () => {
  for (const name of Object.keys(placerEffects)) expect(entries).toHaveProperty(name)
  for (const name of Object.keys(pendingEffects))
    expect(entries).toHaveProperty(name === 'settled' ? 'pendingSettled' : name)
})
it.each(Object.keys(entries).flatMap((name) => [false, true].map((live) => ({ name, live }))))(
  'D-206/D-207 $name has no effects under a directory hold (live=$live)',
  async ({ name, live }) => {
    const f = await fixture(
      name !== 'adoptExisting',
      live,
      name === 'finishRetirement' || name === 'recoverRetirement'
    )
    expect(await f.placer.refusal(f.change, f.entry)).toBeTruthy()
    await entries[name]!(f)
    for (const effect of f.effects) expect(effect).not.toHaveBeenCalled()
    expect(await f.state.byFileId('f')).toEqual(f.entry)
    expect(await f.fs.read(f.entry.path)).toEqual(f.bytes)
  }
)

it('D-206 scope recheck reports held and preserves an unchanged missing remote file', async () => {
  const f = await fixture(false)
  const client = {
    manifest: async () => ({ items: [], head_seq: 0, next: null }),
    changes: async () => ({ items: [], head_seq: 0, next_since: 0 }),
    getBlob: vi.fn(),
  } as unknown as EngineClient
  const report = await pull(client, f.fs, f.state, { ...f.opts, recheck: new Set(['f']) })
  expect(report.applied).toBe(0)
  expect(report.held).toEqual([expect.objectContaining({ file_id: 'f' })])
  expect(await f.fs.read(f.entry.path)).toEqual(f.bytes)
  expect(await f.state.byFileId('f')).toEqual(f.entry)
})
