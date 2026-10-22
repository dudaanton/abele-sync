import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'
import { PullHolds } from '../../src/pullHolds.js'

it('retains tombstones for distinct identities sharing a destination', async () => {
  const f = await fixture(0)
  const base = f.changes[0]!
  f.changes.splice(
    0,
    f.changes.length,
    { ...base, seq: 2, op: 'delete', sha: null, size: null, mtime: null },
    { ...base, seq: 3, file_id: 'other', op: 'move', prev_path: 'b.bin' },
    { ...base, seq: 4, file_id: 'other', op: 'delete', sha: null, size: null, mtime: null }
  )
  f.client.changes = async (since) => ({
    items: f.changes.filter((c) => c.seq > since).slice(0, 1),
    next_since: Math.min(since + 1, 4),
    head_seq: 4,
  })
  await f.run()
  expect(await f.fs.stat('a.bin')).toBeNull()
  expect(await f.state.byFileId('f')).toBeNull()
  expect(await f.state.getCursor()).toBe(4)
})

async function fixture(local: number, inventory = false) {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = [0, 1, 2].map((n) => new Uint8Array([n])),
    hashes = await Promise.all(bytes.map(sha256))
  await fs.writeAtomic('a.bin', bytes[local]!, 1)
  await state.put({
    fileId: 'f',
    versionId: 'v0',
    path: 'a.bin',
    wirePath: 'a.bin',
    sha: hashes[0]!,
    size: 1,
    mtime: 1,
  })
  await state.setCursor(inventory ? 0 : 1)
  const changes: ChangeItem[] = [1, 2].map((n) => ({
    seq: n + 1,
    file_id: 'f',
    version_id: `v${n}`,
    path: 'a.bin',
    op: 'modify',
    prev_path: null,
    kind: 'attachment',
    sha: hashes[n]!,
    size: 1,
    mtime: 1,
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }))
  const getBlob = vi.fn(async (sha: string) => bytes[hashes.indexOf(sha)]!)
  const client = {
    manifest: async () => ({ items: [changes[0]], head_seq: 2, next: null }),
    changes: async (since: number) => ({
      items: changes.filter((c) => c.seq > since).slice(0, 1),
      next_since: since < 2 ? 2 : 3,
      head_seq: 3,
    }),
    getBlob,
  } as unknown as EngineClient
  const effects = vi.spyOn(fs, 'conditionalFile')
  return {
    fs,
    state,
    client,
    effects,
    getBlob,
    bytes,
    hashes,
    changes,
    run: () =>
      pull(client, fs, state, {
        expected: new ExpectedWrites(),
        dirty: new Set(),
        filter: { excluded: () => false },
      }),
  }
}

it.each([false, true])(
  'never places an intermediate version across feed pages (inventory=%s)',
  async (inventory) => {
    const f = await fixture(0, inventory)
    await f.run()
    expect(await f.fs.read('a.bin')).toEqual(f.bytes[2])
    expect(f.getBlob.mock.calls.map(([sha]) => sha)).toEqual([f.hashes[2]])
    expect(f.effects).toHaveBeenCalledTimes(1)
  }
)

it.each([false, true])(
  'adopts freshly equal newest content over an old ledger without effects (inventory=%s)',
  async (inventory) => {
    const f = await fixture(2, inventory)
    await f.run()
    expect(await f.state.get('a.bin')).toMatchObject({ versionId: 'v2', sha: f.hashes[2] })
    expect(f.getBlob).not.toHaveBeenCalled()
    expect(f.effects).not.toHaveBeenCalled()
  }
)

it('coalesces a rename chain before touching either intermediate destination', async () => {
  const f = await fixture(0)
  f.changes[0] = { ...f.changes[0]!, op: 'move', path: 'middle.bin', prev_path: 'a.bin' }
  f.changes[1] = { ...f.changes[1]!, op: 'move', path: 'last.bin', prev_path: 'middle.bin' }
  await f.run()
  expect(await f.fs.stat('middle.bin')).toBeNull()
  expect(await f.fs.read('last.bin')).toEqual(f.bytes[2])
  expect(f.getBlob.mock.calls.map(([sha]) => sha)).toEqual([f.hashes[2]])
  expect(
    f.effects.mock.calls.some(
      ([op]) =>
        op.path === 'middle.bin' || (op.effect.kind === 'move' && op.effect.to === 'middle.bin')
    )
  ).toBe(false)
})

it.each(['held', 'refused'])(
  'a newer applied path identity supersedes an older %s obligation',
  async (kind) => {
    const f = await fixture(0)
    f.changes[1] = { ...f.changes[1]!, file_id: 'replacement', sha: f.hashes[0]! }
    const inbox =
      kind === 'held'
        ? new PullHolds(f.state)
        : new PullHolds(
            f.state,
            'pull-refused-progress',
            (id) => `pull-refused:${encodeURIComponent(id)}`
          )
    await inbox.load()
    inbox.put({ change: f.changes[0]!, base: 'v0', firstSeq: 2 })
    await f.state.transaction((tx) => inbox.persist(3, true, tx))
    const report = await f.run()
    expect(report.held).toEqual([])
    expect(await f.state.byFileId('f')).toBeNull()
    expect(await f.state.get('a.bin')).toMatchObject({ fileId: 'replacement', versionId: 'v2' })
    expect(await f.fs.read('a.bin')).toEqual(f.bytes[0])
    expect(f.effects).not.toHaveBeenCalled()
    expect(f.getBlob).not.toHaveBeenCalled()
  }
)

it('adopts a replacement identity whose newest bytes equal the edited occupant', async () => {
  const f = await fixture(2)
  f.changes[1] = { ...f.changes[1]!, file_id: 'replacement' }
  const report = await f.run()
  expect(report.held).toEqual([])
  expect(await f.state.byFileId('f')).toBeNull()
  expect(await f.state.get('a.bin')).toMatchObject({ fileId: 'replacement', sha: f.hashes[2] })
  expect(f.effects).not.toHaveBeenCalled()
  expect(f.getBlob).not.toHaveBeenCalled()
})

it.each(['held', 'refused'])(
  'never adopts an older %s record beneath a newer held path identity',
  async (kind) => {
    const f = await fixture(1)
    f.changes[1] = { ...f.changes[1]!, file_id: 'replacement' }
    const inbox =
      kind === 'held'
        ? new PullHolds(f.state)
        : new PullHolds(
            f.state,
            'pull-refused-progress',
            (id) => `pull-refused:${encodeURIComponent(id)}`
          )
    await inbox.load()
    inbox.put({ change: f.changes[0]!, base: 'v0', firstSeq: 2 })
    await f.state.transaction((tx) => inbox.persist(3, true, tx))
    const report = await f.run()
    expect(await f.fs.read('a.bin')).toEqual(f.bytes[1])
    expect(await f.state.get('a.bin')).toMatchObject({ versionId: 'v0', sha: f.hashes[0] })
    expect(report.held.some((change) => change.version_id === 'v2')).toBe(true)
    expect(await f.state.getCursor()).toBeLessThan(3)
  }
)
