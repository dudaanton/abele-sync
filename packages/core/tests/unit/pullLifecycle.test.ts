import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { applyStaged } from '../../src/puller.js'
import { sha256 } from '../../src/hash.js'
import { SyncEngine } from '../../src/engine.js'
import { selectiveDefaults } from '../../src/selective.js'
import type { EngineClient } from '../../src/engineClient.js'
import { recoverPendingPullWrites } from '../../src/pullRecovery.js'

it.each([1, 4])('D-015 resumes a buffered move before a %i-byte replacement', async (size) => {
  const f = await fixture()
  f.bytes = new Uint8Array(size).fill(2)
  f.sha = await sha256(f.bytes)
  const old = new Uint8Array([1])
  const base = {
    path: 'before.bin',
    wirePath: 'before.bin',
    fileId: 'file',
    versionId: 'old',
    sha: await sha256(old),
    size: 1,
    mtime: 1,
  }
  await f.state.put(base)
  await f.fs.writeAtomic('file.bin', old, 1)
  await f.state.setMeta(
    'pull-write:file',
    JSON.stringify({
      fileId: 'file',
      versionId: 'new',
      wirePath: 'file.bin',
      sha: f.sha,
      size,
      mtime: 2,
      target: 'file.bin',
      from: 'before.bin',
      base,
    })
  )
  let downloads = 0
  await recoverPendingPullWrites(f.fs, f.state, ['file'], {
    getBlob: async () => {
      downloads++
      return f.bytes
    },
  })
  expect(await f.fs.read('file.bin')).toEqual(f.bytes)
  expect(await f.state.get('before.bin')).toBeNull()
  expect(await f.state.get('file.bin')).toMatchObject({ versionId: 'new' })
  expect(await f.state.getMeta('pull-write:file')).toBeNull()
  expect(downloads).toBe(1)
})

async function fixture() {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([2]),
    sha = await sha256(bytes)
  const change: ChangeItem = {
    seq: 2,
    file_id: 'file',
    version_id: 'new',
    path: 'file.bin',
    prev_path: null,
    op: 'modify',
    sha,
    size: 1,
    mtime: 2,
    kind: 'attachment',
    actor: { kind: 'system', id: 'server', name: 'server' },
    at: '',
  }
  const client = {
    openVersion: async () => ({
      size: 1,
      read: async () => bytes,
      assertUnchanged: async () => {},
      close: async () => {},
    }),
  } as unknown as EngineClient
  return { fs, state, bytes, sha, change, client }
}
it.each([undefined, 11])(
  'recovery orders a receipt by its real sequence, never a synthetic one (seq=%s)',
  async (seq) => {
    const f = await fixture()
    const old = new Uint8Array([1])
    const base = {
      path: 'file.bin',
      wirePath: 'file.bin',
      fileId: 'file',
      versionId: 'old',
      sha: await sha256(old),
      size: 1,
      mtime: 1,
    }
    await f.fs.writeAtomic('file.bin', old, 1)
    await f.state.put(base)
    await f.state.setMeta(
      'pull-applied:file',
      JSON.stringify({ generation: null, seq: 10, version: 'old', absent: false })
    )
    await f.fs.conditionalFile!({
      path: 'file.bin',
      expected: base,
      effect: { kind: 'write', bytes: f.bytes, mtime: 2, receipt: 'receipt' },
    })
    await f.state.setMeta(
      'pull-write:file',
      JSON.stringify({
        ...(seq === undefined ? {} : { seq }),
        receiptId: 'receipt',
        fileId: 'file',
        versionId: 'new',
        wirePath: 'file.bin',
        sha: f.sha,
        size: 1,
        mtime: 2,
        target: 'file.bin',
        from: null,
        base,
      })
    )
    await recoverPendingPullWrites(f.fs, f.state, ['file'])
    expect(await f.state.byFileId('file')).toMatchObject({ versionId: 'new' })
    expect(await f.state.getMeta('pull-write:file')).toBeNull()
    const proof = await f.state.getMeta('pull-applied:file')
    if (seq === undefined) expect(proof).toBeNull()
    else expect(JSON.parse(proof!)).toMatchObject({ seq: 11, version: 'new' })
  }
)
it('D-016 persists pull ownership before stage allocation and keeps its stage id before creation', async () => {
  const f = await fixture()
  f.fs.reopenStage = async () => {
    throw new Error('no stage')
  }
  f.fs.beginAtomicWrite = async (_path, _mtime, _base, beforeCreate) => {
    expect(await f.state.getMeta('pull-write:file')).not.toBeNull()
    expect(beforeCreate).toBeTypeOf('function')
    await beforeCreate!('allocated')
    expect(JSON.parse((await f.state.getMeta('pull-write:file'))!).stageId).toBe('allocated')
    throw new Error('allocation interrupted')
  }
  await expect(
    applyStaged(f.client, f.fs, f.state, [f.change], {
      expected: new ExpectedWrites(),
      prefetchBytes: 0,
      dirty: new Set(),
      filter: { excluded: () => false },
    })
  ).rejects.toThrow('allocation interrupted')
})

it('D-016 retains the intent through stage discard after the installed file ledger is durable', async () => {
  const f = await fixture()
  const stage = {
    id: 'stage',
    offset: 0,
    append: async () => {},
    seal: async () => {},
    commit: async () => {
      await f.fs.writeAtomic('file.bin', f.bytes, 2)
    },
    discard: async () => {
      expect(await f.state.get('file.bin')).toMatchObject({ versionId: 'new' })
      expect(await f.state.getMeta('pull-write:file')).not.toBeNull()
    },
  }
  f.fs.beginAtomicWrite = async () => stage
  f.fs.reopenStage = async () => stage
  await applyStaged(f.client, f.fs, f.state, [f.change], {
    expected: new ExpectedWrites(),
    prefetchBytes: 0,
    dirty: new Set(),
    filter: { excluded: () => false },
  })
  expect(await f.state.getMeta('pull-write:file')).toBeNull()
})

it('D-016 engine startup settles a completed old-version pull before scan or a newer feed', async () => {
  const f = await fixture()
  const base = {
    path: 'file.bin',
    wirePath: 'file.bin',
    fileId: 'file',
    versionId: 'old',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
  }
  await f.state.put(base)
  await f.fs.writeAtomic('file.bin', new Uint8Array([1]), 1)
  await f.fs.conditionalFile!({
    path: 'file.bin',
    expected: base,
    effect: { kind: 'write', bytes: f.bytes, mtime: 2, receipt: 'completed-pull' },
  })
  await f.state.setCursor(1)
  await f.state.setMeta(
    'pull-write:file',
    JSON.stringify({
      receiptId: 'completed-pull',
      fileId: 'file',
      versionId: 'new',
      wirePath: 'file.bin',
      sha: f.sha,
      size: 1,
      mtime: 2,
      target: 'file.bin',
      from: null,
      base,
    })
  )
  const client = {
    state: async () => ({ head_seq: 2, settings: { max_file_bytes: 10000, quota_bytes: null } }),
    changes: async () => ({ items: [], next_since: 2, head_seq: 2 }),
  } as unknown as EngineClient
  const engine = new SyncEngine({
    fs: f.fs,
    state: f.state,
    client,
    selective: selectiveDefaults(),
  })
  await engine.sync()
  expect(await f.state.get('file.bin')).toMatchObject({ versionId: 'new' })
  expect(await f.state.getMeta('pull-write:file')).toBeNull()
  await engine.stop()
})
