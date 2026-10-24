import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites, sha256 } from '../../src/index.js'
import { pull, applyStaged } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'
import { V2Directories } from '../../src/v2Directories.js'
import { SyncEngine } from '../../src/engine.js'
import { selectiveDefaults } from '../../src/selective.js'
import { FileRetries } from '../../src/fileRetry.js'
import { scan } from '../../src/scanner.js'
import { push } from '../../src/pusher.js'
import { pathAdmission } from '../../src/pathAdmission.js'
import { PendingPullWrites } from '../../src/pullWrite.js'

it('rechecks directory admission after awaited inventory and before mkdir', async () => {
  let allowed = true
  class DirectoryFs extends MemoryFileSystem {
    [pathAdmission]() {
      return allowed
        ? { allowed: true as const }
        : { allowed: false as const, reason: 'unsupported-host-name: changed policy' }
    }
    async *listDirectories() {
      allowed = false
      yield* []
    }
    mkdir = vi.fn(async (_path: string) => {})
  }
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  await new V2Directories(fs, state, () => true, vi.fn()).receive(
    { file_id: 'dir', version_id: 'v1', path: 'a:b', kind: 'directory', mtime: 1 },
    7
  )
  expect(fs.mkdir).not.toHaveBeenCalled()
  const engine = new SyncEngine({
    fs,
    state,
    client: {} as EngineClient,
    selective: selectiveDefaults(),
  })
  expect(await engine.waitingFiles()).toEqual([
    expect.objectContaining({
      fileId: 'dir',
      versionId: 'v1',
      seq: 7,
      reason: 'unsupported-host-name: changed policy',
    }),
  ])
})

async function feedFixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  Object.assign(fs, {
    [pathAdmission]: (path: string) =>
      path.includes(':')
        ? { allowed: false, reason: 'unsupported-host-name: colon' }
        : { allowed: true },
  })
  await state.setCursor(1)
  const bytes = new Uint8Array([1])
  const change: ChangeItem = {
    seq: 2,
    file_id: 'file',
    version_id: 'v2',
    op: 'create',
    path: 'a:b',
    prev_path: null,
    sha: await sha256(bytes),
    size: 1,
    mtime: 1,
    kind: 'attachment',
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  const feed = [change],
    getBlob = vi.fn(async () => bytes)
  const client = {
    changes: async (since: number) => ({
      items: feed.filter((c) => c.seq > since),
      head_seq: feed.at(-1)!.seq,
      next_since: feed.at(-1)!.seq,
    }),
    getBlob,
  } as unknown as EngineClient
  const opts = {
    expected: new ExpectedWrites(),
    dirty: new Set<string>(),
    filter: { excluded: () => false },
  }
  return {
    fs,
    state,
    change,
    feed,
    getBlob,
    client,
    opts,
    run: () => pull(client, fs, state, opts),
  }
}

it.each(['rename', 'delete'] as const)(
  'superseding %s retires an exact denied obligation',
  async (mode) => {
    const f = await feedFixture()
    await f.run()
    expect(JSON.parse((await f.state.getMeta('pull-refused:file'))!).change).toEqual(f.change)
    f.feed.push({
      ...f.change,
      seq: 3,
      version_id: 'v3',
      op: mode === 'delete' ? 'delete' : 'move',
      path: mode === 'delete' ? 'a:b' : 'allowed',
      prev_path: mode === 'delete' ? null : 'a:b',
      ...(mode === 'delete' ? { sha: null, size: null, mtime: null } : {}),
    })
    await f.run()
    expect(await f.state.getMeta('pull-refused:file')).toBeNull()
    expect(await f.state.getCursor()).toBe(3)
    expect(f.getBlob).toHaveBeenCalledTimes(mode === 'delete' ? 0 : 1)
  }
)

it('does not advance the cursor if persisting a denied obligation fails', async () => {
  const f = await feedFixture()
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = (work) =>
    transaction(async (tx) => {
      const setMeta = tx.setMeta!.bind(tx)
      tx.setMeta = async (key, value) => {
        if (key === 'pull-refused:file' && value !== null) throw new Error('durability failure')
        await setMeta(key, value)
      }
      return work(tx)
    })
  await expect(f.run()).rejects.toThrow('durability failure')
  expect(await f.state.getCursor()).toBe(1)
  expect(f.getBlob).not.toHaveBeenCalled()
})

it('checks admission on deferred approval and pending placement without fetching', async () => {
  const f = await feedFixture()
  const result = await applyStaged(f.client, f.fs, f.state, [f.change], f.opts)
  expect(result.rejected?.[0]?.message).toBe('unsupported-host-name: colon')
  expect(f.getBlob).not.toHaveBeenCalled()
  expect(await new PendingPullWrites(f.state, f.fs).refused('file', ['a:b'])).toMatchObject({
    message: 'unsupported-host-name: colon',
  })
})

it('durably holds a denied exact change without download and replays after policy changes', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  let allowed = false
  Object.assign(fs, {
    [Symbol.for('abele.sync.path-admission-v1')]: () =>
      allowed ? { allowed: true } : { allowed: false, reason: 'unsupported-host-name: colon' },
  })
  const bytes = new Uint8Array([1])
  const change: ChangeItem = {
    seq: 1,
    file_id: 'file',
    version_id: 'v1',
    op: 'create',
    path: 'a:b',
    prev_path: null,
    sha: await sha256(bytes),
    size: 1,
    mtime: 1,
    kind: 'attachment',
    actor: { kind: 'system', id: 'server', name: 'server' },
    at: '',
  }
  const getBlob = vi.fn(async () => bytes)
  const client = {
    manifest: async () => ({ items: [change], head_seq: 1, next: null }),
    changes: async () => ({ items: [], head_seq: 1, next_since: 1 }),
    getBlob,
  } as unknown as EngineClient
  const run = () =>
    pull(client, fs, state, {
      dirty: new Set(),
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    })
  await run()
  expect(getBlob).not.toHaveBeenCalled()
  expect(await fs.stat(change.path)).toBeNull()
  expect(await state.getCursor()).toBe(1)
  const held = JSON.parse((await state.getMeta('pull-refused:file'))!)
  expect(held).toMatchObject({
    change: {
      ...change,
      actor: { kind: 'system', id: 'manifest', name: 'manifest' },
      at: expect.any(String),
    },
    reason: 'unsupported-host-name: colon',
  })
  const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
  expect(await engine.waitingFiles()).toEqual([
    expect.objectContaining({
      path: 'a:b',
      fileId: 'file',
      versionId: 'v1',
      seq: 1,
      reason: 'unsupported-host-name: colon',
    }),
  ])
  await run() // fresh PullRun reads durable ownership
  expect(await state.getMeta('pull-refused:file')).toBe(JSON.stringify(held))
  expect(getBlob).not.toHaveBeenCalled()
  allowed = true
  await run()
  expect(await fs.read(change.path)).toEqual(bytes)
  expect(await state.getMeta('pull-refused:file')).toBeNull()
})

it('retains a denied push receipt without fetching the returned version', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  Object.assign(fs, {
    [Symbol.for('abele.sync.path-admission-v1')]: (path: string) =>
      path.includes(':')
        ? { allowed: false, reason: 'unsupported-host-name: colon' }
        : { allowed: true },
  })
  await fs.writeAtomic('local.bin', new Uint8Array([1]), 1)
  const bytes = new Uint8Array([2]),
    sha = await sha256(bytes)
  const getBlob = vi.fn(async () => bytes)
  const client = {
    hasBlob: async () => true,
    getBlob,
    commitRaw: async () => ({
      replayed: false,
      body: {
        head_seq: 1,
        results: [
          {
            status: 'merged',
            file_id: 'file',
            version_id: 'v1',
            seq: 1,
            path: 'a:b',
            sha,
            size: 1,
            mtime: 1,
            kind: 'attachment',
          },
        ],
      },
    }),
  } as unknown as EngineClient
  const retries = new FileRetries(
    state,
    () => 0,
    () => {}
  )
  await push(client, fs, state, await scan(fs, state, { excluded: () => false }), {
    expected: new ExpectedWrites(),
    retries,
  })
  expect(getBlob).not.toHaveBeenCalled()
  expect(await fs.stat('a:b')).toBeNull()
  expect(await fs.read('local.bin')).toEqual(new Uint8Array([1]))
  expect(await state.metadataKeys('push-receipt:')).toHaveLength(1)
  expect(retries.list()).toEqual([expect.objectContaining({ quarantined: true })])
})

it('holds directory identity and sequence before mkdir, and replays a changed host policy', async () => {
  class DirectoryFs extends MemoryFileSystem {
    directories = new Set<string>()
    async mkdir(path: string) {
      this.directories.add(path)
    }
    async *listDirectories() {
      for (const path of this.directories) yield { path, identity: path, mtime: 1 }
    }
  }
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  let allowed = false
  Object.assign(fs, {
    [Symbol.for('abele.sync.path-admission-v1')]: () =>
      allowed ? { allowed: true } : { allowed: false, reason: 'unsupported-host-name: colon' },
  })
  const mkdir = vi.spyOn(fs, 'mkdir'),
    commit = vi.fn()
  const dirs = () => new V2Directories(fs, state, () => true, commit)
  const item = {
    file_id: 'dir',
    version_id: 'v1',
    path: 'a:b',
    kind: 'directory' as const,
    mtime: 1,
  }
  await dirs().receive(item, 7)
  expect(mkdir).not.toHaveBeenCalled()
  const engine = new SyncEngine({
    fs,
    state,
    client: {} as EngineClient,
    selective: selectiveDefaults(),
  })
  expect(await engine.waitingFiles()).toEqual([
    expect.objectContaining({
      path: 'a:b',
      fileId: 'dir',
      versionId: 'v1',
      seq: 7,
      reason: 'unsupported-host-name: colon',
    }),
  ])
  await dirs().receive({ ...item, version_id: 'older', path: 'old:name' }, 6)
  await dirs().departed('dir', false, 6)
  expect(await engine.waitingFiles()).toEqual([
    expect.objectContaining({ path: 'a:b', versionId: 'v1', seq: 7 }),
  ])
  allowed = true
  await dirs().scan()
  expect(mkdir).toHaveBeenCalledWith('a:b')
  expect(await engine.waitingFiles()).toEqual([])
  expect(commit).not.toHaveBeenCalled()
})
