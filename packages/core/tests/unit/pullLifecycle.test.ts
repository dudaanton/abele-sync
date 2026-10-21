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

it('D-015 resumes a buffered move interrupted before its content replacement', async () => {
  const f = await fixture()
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
      size: 1,
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
  await f.fs.writeAtomic('file.bin', f.bytes, 2)
  await f.state.setCursor(1)
  await f.state.setMeta(
    'pull-write:file',
    JSON.stringify({
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
