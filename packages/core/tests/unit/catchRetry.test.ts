import { expect, it } from 'vitest'
import {
  MemoryFileSystem,
  MemoryStateStore,
  ExpectedWrites,
  sha256,
  scan,
} from '../../src/index.js'
import { PushDisk } from '../../src/pushDisk.js'
import { sourcesFromScan } from '../../src/pushSources.js'
import { PullPlacer } from '../../src/pullPlace.js'
import { SyncEngine, selectiveDefaults, EngineError } from '../../src/index.js'
import { V2EngineClient } from '../../src/v2Client.js'
import { encodeAccessToken } from '@abele/sync-protocol'
import { judgeDeletes } from '../../src/deletes.js'

it('D-095 an unreadable tracked file does not block an unrelated delete', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  const base = {
    path: 'unread.bin',
    wirePath: 'unread.bin',
    fileId: 'unread',
    versionId: 'base',
    sha,
    size: 1,
    mtime: 1,
  }
  await state.put(base)
  await state.put({ ...base, path: 'gone.bin', wirePath: 'gone.bin', fileId: 'gone' })
  await fs.writeAtomic('unread.bin', bytes, 2)
  const failure = new EngineError('io', 'EIO reading tracked file')
  fs.read = async () => {
    throw failure
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await scan(fs, state, { excluded: () => false })
    expect(found.skipped).toEqual([expect.objectContaining({ path: 'unread.bin' })])
    expect(found.ops).toEqual([{ op: 'delete', file_id: 'gone', base_version_id: 'base' }])
    expect(await state.get('unread.bin')).toEqual(base)
  }
})

it.each(['new.md', 'other/new.md'])(
  'D-093 retries unread rename candidate %s without a delete or approval',
  async (target) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new TextEncoder().encode('local bytes'),
      sha = await sha256(bytes)
    const base = {
      path: 'old.md',
      wirePath: 'old.md',
      fileId: 'file',
      versionId: 'base',
      sha,
      size: bytes.length,
      mtime: 1,
    }
    await fs.writeAtomic('old.md', bytes, 1)
    await state.put(base)
    await fs.move('old.md', target)
    const read = fs.read.bind(fs)
    fs.read = async (path) => {
      if (path === target) throw new EngineError('io', 'EIO reading rename destination')
      return read(path)
    }
    const filter = { excluded: () => false }
    const found = await scan(fs, state, filter)
    expect(found.skipped).toEqual([expect.objectContaining({ path: target })])
    expect(found.ops).toEqual([])
    expect(
      judgeDeletes(found.ops, [base], filter, new Set(), { count: 1, floor: 1, share: 0 }).held
    ).toEqual([])
    expect(await state.get('old.md')).toEqual(base)
    fs.read = read
    expect((await scan(fs, state, filter)).ops).toEqual([
      { op: 'move', file_id: 'file', base_version_id: 'base', to_path: target },
    ])
  }
)

it('does not run past failed scope marking', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const failure = new Error('scope database unavailable')
  state.getMeta = async () => {
    throw failure
  }
  const engine = new SyncEngine({
    fs,
    state,
    client: {} as import('../../src/engineClient.js').EngineClient,
    selective: selectiveDefaults(),
    recovery: { assertReady() {} },
  })
  await expect(engine.recordScope()).rejects.toBe(failure)
  await engine.stop()
})

it('does not persist group membership without an unreadable note', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await fs.writeAtomic('Root.md', new TextEncoder().encode('root'), 1)
  const scope = { kind: 'group' as const, id: 'root', path: 'Root.md' }
  const client = new V2EngineClient(
    encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
    {
      fetch: async () =>
        Response.json({
          protocol: 2,
          token_id: 'token',
          space_id: 'space',
          scope,
          status: 'active',
          limits: { max_file_bytes: 10000, quota_bytes: null },
        }),
    }
  )
  const failure = new EngineError('io', 'note read unavailable')
  fs.read = async () => {
    throw failure
  }
  await expect(client.prepare(fs, state)).rejects.toBe(failure)
  expect(await state.getMeta('v2-local-group-links')).toBeNull()
})

it('keeps a receipt retryable when submitted-content validation cannot read', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore(),
    bytes = new Uint8Array([1])
  await fs.writeAtomic('file.bin', bytes, 1)
  const content = { sha: await sha256(bytes), size: 1, mtime: 1 }
  const disk = new PushDisk(fs, state, { expected: new ExpectedWrites() }, sha256, new Map())
  const failure = new Error('validation unavailable')
  fs.read = async () => {
    throw failure
  }
  await expect(
    disk.untouched({ op: 'create', path: 'file.bin', ...content }, content, 'file.bin')
  ).rejects.toBe(failure)
})

it.each(['bytes', 'open'] as const)(
  'does not classify an upload source %s failure as missing',
  async (method) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    await fs.writeAtomic('file.bin', new Uint8Array([1]), 1)
    const found = await scan(fs, state, { excluded: () => false })
    const failure = new Error('upload source unavailable')
    fs.read = async () => {
      throw failure
    }
    Object.assign(fs, {
      openRead: async () => {
        throw failure
      },
    })
    const sources = sourcesFromScan(fs, found, state)
    await expect(sources[method]!(found.hashes.get('file.bin')!)).rejects.toBe(failure)
  }
)

it('does not turn a failed rename likeness read into a create and delete', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new TextEncoder().encode('one two three four five six seven eight nine ten')
  await fs.writeAtomic('old.md', bytes, 1)
  await state.put({
    path: 'old.md',
    wirePath: 'old.md',
    fileId: 'file',
    versionId: 'base',
    sha: await sha256(bytes),
    size: bytes.length,
    mtime: 1,
  })
  await fs.move('old.md', 'new.md')
  await fs.writeAtomic(
    'new.md',
    new TextEncoder().encode('one two three four five six seven eight nine changed'),
    2
  )
  const failure = new Error('previous version unavailable')
  await expect(
    scan(
      fs,
      state,
      { excluded: () => false },
      {
        previous: async () => {
          throw failure
        },
      }
    )
  ).rejects.toBe(failure)
})

it('does not hold a pull because resolving its target has an operational failure', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const failure = new Error('path metadata unavailable')
  state.getMeta = async () => {
    throw failure
  }
  const placer = new PullPlacer(
    { getBlob: async () => new Uint8Array([1]) },
    fs,
    state,
    { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } },
    sha256
  )
  const change = {
    seq: 1,
    file_id: 'file',
    version_id: 'v',
    path: 'file.bin',
    prev_path: null,
    op: 'create' as const,
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
    kind: 'attachment' as const,
    actor: { kind: 'system' as const, id: 'server', name: 'server' },
    at: '',
  }
  await expect(placer.place(change, change.sha, null, new Map(), new Map())).rejects.toBe(failure)
})

it('does not classify database contention as a filesystem obstruction', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const failure = new EngineError('conflict', 'database is locked', { code: 'SQLITE_BUSY' })
  state.getMeta = async () => {
    throw failure
  }
  const placer = new PullPlacer(
    { getBlob: async () => new Uint8Array([1]) },
    fs,
    state,
    { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } },
    sha256
  )
  const change = {
    seq: 1,
    file_id: 'file',
    version_id: 'v',
    path: 'file.bin',
    prev_path: null,
    op: 'create' as const,
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
    kind: 'attachment' as const,
    actor: { kind: 'system' as const, id: 'server', name: 'server' },
    at: '',
  }
  await expect(placer.adoptExisting(change, null)).rejects.toBe(failure)
})
