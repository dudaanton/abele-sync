import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { resumeJournal } from '../../src/pusher.js'
import {
  applyStaged,
  pull,
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  sha256,
  type EngineClient,
  type FileSystem,
} from '../../src/index.js'

it('reports pull upsert, move and delete once after applying; isolates hook errors', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new TextEncoder().encode('hello'),
    sha = await sha256(bytes)
  const change: ChangeItem = {
    seq: 1,
    file_id: 'f',
    version_id: 'v1',
    path: 'a.md',
    prev_path: null,
    op: 'create',
    sha,
    size: 5,
    mtime: 1,
    kind: 'note',
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  const client = { getBlob: async () => bytes } as unknown as EngineClient
  const onApplied = vi.fn(),
    log = vi.fn()
  const opts = {
    filter: { excluded: () => false },
    dirty: new Set<string>(),
    expected: new ExpectedWrites(),
    onApplied,
    log,
  }
  await applyStaged(client, fs, state, [change], opts)
  await applyStaged(client, fs, state, [change], opts)
  await applyStaged(client, fs, state, [{ ...change, version_id: 'v2', op: 'delete', sha: null }], {
    ...opts,
    dirty: new Set(['a.md']),
  })
  expect(onApplied).toHaveBeenCalledTimes(1)
  onApplied.mockImplementation(() => {
    throw new Error('host failed')
  })
  await applyStaged(
    client,
    fs,
    state,
    [{ ...change, version_id: 'v2', op: 'move', path: 'b.md', prev_path: 'a.md' }],
    opts
  )
  await applyStaged(
    client,
    fs,
    state,
    [{ ...change, version_id: 'v3', op: 'delete', path: 'b.md', sha: null }],
    opts
  )
  expect(onApplied.mock.calls.map(([event]) => event)).toEqual([
    { path: 'a.md', kind: 'upsert', origin: 'remote', fileId: 'f' },
    { path: 'b.md', kind: 'move', from: 'a.md', origin: 'remote', fileId: 'f' },
    { path: 'b.md', kind: 'delete', origin: 'remote', fileId: 'f' },
  ])
  expect(log).toHaveBeenCalledWith(expect.stringContaining('host failed'))
})

it.each([
  { deferred: false, refused: false },
  { deferred: true, refused: false },
  { deferred: false, refused: true },
])('reports accepted push after commit (%j)', async ({ deferred, refused }) => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new TextEncoder().encode('hello'),
    sha = await sha256(bytes)
  await fs.writeAtomic('b.md', bytes, 1)
  await state.put({
    path: 'a.md',
    wirePath: 'a.md',
    fileId: 'f',
    versionId: 'v1',
    sha,
    size: 5,
    mtime: 1,
  })
  await state.setJournal({
    batchId: 'batch',
    idempotencyKey: 'key',
    startedAt: new Date().toISOString(),
    ops: [{ op: 'move', file_id: 'f', base_version_id: 'v1', to_path: 'b.md' }],
  })
  const client = {
    hasBlob: async () => true,
    commitRaw: async () => ({
      replayed: false,
      body: {
        head_seq: 2,
        results: [
          refused
            ? { status: 'rejected', code: 'forbidden', message: 'refused' }
            : {
                status: 'applied',
                file_id: 'f',
                version_id: 'v2',
                path: 'b.md',
                sha,
                size: 5,
                mtime: 1,
              },
        ],
      },
    }),
  } as unknown as EngineClient
  const observed: unknown[] = []
  const onApplied = vi.fn(async () => {
    observed.push(await state.getJournal(), (await state.byFileId('f'))?.versionId)
  })
  await resumeJournal(client, fs, state, {
    expected: new ExpectedWrites(),
    onApplied,
    defer: deferred ? (path) => path === 'a.md' : undefined,
  })
  if (deferred || refused) expect(onApplied).not.toHaveBeenCalled()
  else {
    expect(observed).toEqual([null, 'v2'])
    expect(onApplied).toHaveBeenCalledExactlyOnceWith({
      path: 'b.md',
      kind: 'move',
      from: 'a.md',
      origin: 'local',
      fileId: 'f',
    })
  }
})

it('does not report a deferred pull until the host applies it', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await state.setCursor(1)
  const bytes = new TextEncoder().encode('hello'),
    sha = await sha256(bytes)
  const change: ChangeItem = {
    seq: 2,
    file_id: 'f',
    version_id: 'v',
    path: 'a.md',
    prev_path: null,
    op: 'create',
    sha,
    size: 5,
    mtime: 1,
    kind: 'note',
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  const client = {
    changes: async () => ({ items: [change], next_since: 2, head_seq: 2 }),
    getBlob: async () => bytes,
  } as unknown as EngineClient
  const onApplied = vi.fn(),
    onDefer = vi.fn()
  const opts = {
    filter: { excluded: () => false },
    dirty: new Set<string>(),
    expected: new ExpectedWrites(),
    onApplied,
  }
  const report = await pull(client, fs, state, { ...opts, defer: () => true, onDefer })
  expect(report.deferred).toBe(1)
  expect(onApplied).not.toHaveBeenCalled()
  expect(await fs.stat('a.md')).toBeNull()
  await applyStaged(client, fs, state, [change], opts)
  expect(onApplied).toHaveBeenCalledExactlyOnceWith({
    path: 'a.md',
    kind: 'upsert',
    origin: 'remote',
    fileId: 'f',
  })
})

it('reports streamed pull only after AtomicStage commit and ledger commit', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new TextEncoder().encode('hello'),
    sha = await sha256(bytes)
  const change: ChangeItem = {
    seq: 1,
    file_id: 'f',
    version_id: 'v',
    path: 'a.md',
    prev_path: null,
    op: 'create',
    sha,
    size: 5,
    mtime: 1,
    kind: 'note',
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  const order: string[] = []
  fs.discardStage = async () => {}
    fs.reopenStage = async () => {
    throw new Error('not a restart')
  }
  fs.beginAtomicWrite = async (path, mtime) => {
    let offset = 0
    return {
      id: 'stage',
      get offset() {
        return offset
      },
      async append(at, chunk) {
        expect(at).toBe(offset)
        offset += chunk.length
      },
      async seal(identity) {
        expect(identity).toEqual({ sha, size: 5 })
      },
      async commit() {
        await fs.writeAtomic(path, bytes, mtime)
        order.push('commit')
      },
      async discard() {},
    }
  }
  const client = {
    openVersion: async () => ({
      size: 5,
      read: async (at: number, length: number) => bytes.slice(at, at + length),
      assertUnchanged: async () => {},
      close: async () => {},
    }),
  } as unknown as EngineClient
  const observed: unknown[] = []
  const onApplied = vi.fn(async () => {
    order.push('hook')
    observed.push(await fs.read('a.md'), (await state.byFileId('f'))?.versionId)
  })
  await applyStaged(client, fs, state, [change], {
    filter: { excluded: () => false },
    dirty: new Set(),
    expected: new ExpectedWrites(),
    onApplied,
  })
  expect(order).toEqual(['commit', 'hook'])
  expect(observed).toEqual([bytes, 'v'])
  expect(onApplied).toHaveBeenCalledTimes(1)
})
