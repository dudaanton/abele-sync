import {
  AbeleError,
  type ChangeItem,
  type CommitOpResult,
  type V2CommitOp,
} from '@abele/sync-protocol'
import { expect, it, vi } from 'vitest'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { V2Directories } from '../../src/v2Directories.js'
import { EngineError } from '../../src/errors.js'
import { SyncEngine } from '../../src/engine.js'
import { selectiveDefaults } from '../../src/selective.js'
import { V2EngineClient } from '../../src/v2Client.js'
import { encodeAccessToken } from '@abele/sync-protocol'
import { sha256 } from '../../src/hash.js'
import { applyStaged, pull } from '../../src/puller.js'
import { ExpectedWrites } from '../../src/echo.js'
import { resumeJournal } from '../../src/pusher.js'
import type { EngineClient } from '../../src/engineClient.js'
import { stoppableClient } from '../../src/guard.js'
import { readStaged, StagedChanges } from '../../src/defer.js'

it.each([false, true])(
  'lists deferred changes behind a directory hold (already refused=%s)',
  async (alreadyRefused) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new Uint8Array([1]),
      sha = await sha256(bytes)
    await state.setCursor(1)
    const change: ChangeItem = {
      seq: 2,
      file_id: 'code',
      version_id: 'v2',
      path: 'blocked/main.js',
      prev_path: null,
      kind: 'attachment',
      op: 'create',
      sha,
      size: 1,
      mtime: 1,
      actor: { kind: 'system', id: 'test', name: 'test' },
      at: '',
    }
    let refusing = true
    const getBlob = vi.fn(async () => bytes)
    const client = {
      changes: async (since: number) => ({
        items: since < 2 ? [change] : [],
        next_since: 2,
        head_seq: 2,
      }),
      pathRefusal: () =>
        refusing ? { code: 'conflict', message: 'directory evidence is ambiguous' } : undefined,
      getBlob,
    } as unknown as EngineClient
    const options = {
      expected: new ExpectedWrites(),
      dirty: new Set<string>(),
      filter: { excluded: () => false },
    }
    if (alreadyRefused) await pull(client, fs, state, options)
    const staged = new StagedChanges(state, fs)
    await pull(client, fs, state, {
      ...options,
      defer: () => true,
      onDefer: (rows) => staged.stage(rows),
    })
    expect((await readStaged(state)).map((row) => row.version_id)).toEqual(['v2'])
    expect(getBlob).not.toHaveBeenCalled()
    expect(await fs.stat(change.path)).toBeNull()
    const held = await applyStaged(client, fs, state, [change], options)
    expect(held.applied).toBe(0)
    expect(held.held).toEqual([change])
    expect(getBlob).not.toHaveBeenCalled()
    expect(await fs.stat(change.path)).toBeNull()
    refusing = false
    const installed = await applyStaged(client, fs, state, [change], options)
    expect(installed.applied).toBe(1)
    expect(await fs.read(change.path)).toEqual(bytes)
  }
)

class DirectoryFs extends MemoryFileSystem {
  dirs = new Map<string, string>()
  async *listDirectories() {
    for (const [path, identity] of this.dirs) yield { path, identity, mtime: 1 }
  }
  async mkdir(path: string) {
    this.dirs.set(path, path)
  }
}

it('a fresh V2 engine loads durable directory holds before approving staged code', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  const change: ChangeItem = {
    seq: 2,
    file_id: 'code',
    version_id: 'v2',
    path: 'blocked/main.js',
    prev_path: null,
    kind: 'attachment',
    op: 'create',
    sha,
    size: 1,
    mtime: 1,
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  await new StagedChanges(state, fs).stage([{ change, base: null }])
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: [],
      removals: [],
      refused: [
        {
          path: 'blocked',
          source: 'old',
          code: 'conflict',
          message: 'ambiguous',
          direction: 'push',
          evidence: true,
        },
      ],
    })
  )
  const fetch = vi.fn(async () => new Response(bytes))
  const client = new V2EngineClient(
    encodeAccessToken({
      v: 1,
      address: 'https://synthetic.example.test',
      key: 'k'.repeat(43),
      scope: { kind: 'folder', id: 'root', path: '/' },
    }),
    { fetch }
  )
  const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
  try {
    const result = await engine.applyDeferred(['v2'])
    expect(result).toEqual({ applied: [], skipped: ['blocked/main.js'], unshown: [] })
    expect(await readStaged(state)).toEqual([change])
    expect(await fs.stat(change.path)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await engine.stop()
  }
})

it.each(['tracked', 'previous'] as const)(
  'D-202 fresh approval protects a held move source (%s)',
  async (source) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new Uint8Array([1]),
      sha = await sha256(bytes)
    const change: ChangeItem = {
      seq: 2,
      file_id: 'code',
      version_id: 'v2',
      path: 'free/main.js',
      prev_path: source === 'previous' ? 'blocked/main.js' : null,
      kind: 'attachment',
      op: 'move',
      sha,
      size: 1,
      mtime: 1,
      actor: { kind: 'system', id: 'test', name: 'test' },
      at: '',
    }
    const from = source === 'tracked' ? 'blocked/main.js' : 'other/main.js'
    await fs.writeAtomic(from, bytes, 1)
    await state.put({
      fileId: 'code',
      versionId: 'v1',
      path: from,
      wirePath: from,
      sha,
      size: 1,
      mtime: 1,
    })
    await new StagedChanges(state, fs).stage([{ change, base: 'v1' }])
    await state.setMeta(
      'v2-directories',
      JSON.stringify({
        directories: [],
        removals: [],
        refused: [
          {
            path: 'blocked',
            source: 'old',
            code: 'conflict',
            message: 'ambiguous',
            direction: 'push',
            evidence: true,
          },
        ],
      })
    )
    const fetch = vi.fn(async () => new Response(bytes))
    const client = new V2EngineClient(
      encodeAccessToken({
        v: 1,
        address: 'https://synthetic.example.test',
        key: 'k'.repeat(43),
        scope: { kind: 'folder', id: 'root', path: '/' },
      }),
      { fetch }
    )
    const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
    try {
      const result = await engine.applyDeferred(['v2'])
      expect(result).toEqual({ applied: [], skipped: ['free/main.js'], unshown: [] })
      expect(await readStaged(state)).toEqual([change])
      expect(await fs.stat(change.path)).toBeNull()
      expect(await fs.read(from)).toEqual(bytes)
      expect(await state.byFileId('code')).toMatchObject({ versionId: 'v1', path: from })
      expect(JSON.parse((await state.getMeta('v2-directories'))!).refused).toHaveLength(1)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await engine.stop()
    }
  }
)

it('D-136 never publishes a refused event past queued accepted work', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await state.setCursor(1)
  const sha = await sha256(new Uint8Array([1]))
  const change = (seq: number, path: string): ChangeItem => ({
    seq,
    path,
    kind: 'attachment',
    file_id: path,
    version_id: String(seq),
    op: 'create',
    prev_path: null,
    sha,
    size: 1,
    mtime: 1,
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  })
  const client = {
    changes: async () => ({
      items: [change(2, 'a'), change(3, 'blocked/b')],
      next_since: 3,
      head_seq: 3,
    }),
    pathRefusal: (path: string) =>
      path.startsWith('blocked/') ? { code: 'leaves_scope', message: 'policy' } : undefined,
    getBlob: async () => {
      throw new Error('download interrupted')
    },
  } as unknown as EngineClient
  await expect(
    pull(client, fs, state, {
      expected: new ExpectedWrites(),
      dirty: new Set(),
      filter: { excluded: () => false },
    })
  ).rejects.toThrow()
  expect(await state.getCursor()).toBeLessThan(2)
})

it.each([false, true])(
  'D-137 replays a refused deletion after rewind even though it is absent from manifest (staged=%s)',
  async (staged) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore(),
      bytes = new Uint8Array([1])
    const sha = await sha256(bytes)
    await fs.writeAtomic('blocked/a', bytes, 1)
    await state.put({
      fileId: 'a',
      versionId: 'v1',
      path: 'blocked/a',
      wirePath: 'blocked/a',
      sha,
      size: 1,
      mtime: 1,
    })
    await state.setCursor(1)
    let refusing = true
    const deleted: ChangeItem = {
      kind: 'attachment',
      seq: 2,
      file_id: 'a',
      version_id: 'v2',
      path: 'blocked/a',
      prev_path: null,
      op: 'delete',
      sha: null,
      size: null,
      mtime: null,
      actor: { kind: 'system', id: 'test', name: 'test' },
      at: '',
    }
    const client = {
      manifest: async () => ({ items: [], next: null, head_seq: 2 }),
      changes: async (since: number) => ({
        items: since < 2 ? [deleted] : [],
        next_since: 2,
        head_seq: 2,
      }),
      pathRefusal: () => (refusing ? { code: 'leaves_scope', message: 'policy' } : undefined),
    } as unknown as EngineClient
    const options = {
      expected: new ExpectedWrites(),
      dirty: new Set<string>(),
      filter: { excluded: () => false },
    }
    if (staged) await applyStaged(client, fs, state, [deleted], options)
    else await pull(client, fs, state, options)
    expect(await fs.stat('blocked/a')).not.toBeNull()
    refusing = false
    await state.setCursor(0)
    await pull(client, fs, state, options)
    expect(await fs.stat('blocked/a')).toBeNull()
    expect(await state.byFileId('a')).toBeNull()
  }
)

it('D-138 retires the old refusal when its directory moves to an allowed path', async () => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  const mkdir = fs.mkdir.bind(fs)
  fs.mkdir = async (path) => {
    if (path === 'blocked') throw new AbeleError('leaves_scope', 'policy')
    await mkdir(path)
  }
  const dirs = new V2Directories(
    fs,
    state,
    () => true,
    async () => []
  )
  await dirs.receive({
    kind: 'directory',
    path: 'blocked',
    file_id: 'dir',
    version_id: 'v1',
    mtime: 1,
  })
  await dirs.receive({
    kind: 'directory',
    path: 'allowed',
    file_id: 'dir',
    version_id: 'v2',
    mtime: 1,
  })
  expect(dirs.refusals()).toEqual([])
})

it('does not abandon a started directory retry state write on pause', async () => {
  const controller = new AbortController(),
    active = { count: 0 }
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = stoppableClient(
    {
      retryRefusedDirectories: async () => {
        await gate
      },
    } as EngineClient,
    () => controller.signal,
    active
  )
  const settled = client.retryRefusedDirectories!().then(
    () => true,
    () => false
  )
  controller.abort()
  release()
  expect(await settled).toBe(true)
  expect(active.count).toBe(0)
})

it.each(['quota_exceeded', 'leaves_scope', 'forbidden'] as const)(
  'D-134 records a refused mkdir (%s), skips its subtree, and continues after restart',
  async (code) => {
    const fs = new DirectoryFs(),
      state = new MemoryStateStore()
    for (const path of ['blocked', 'blocked/child', 'allowed']) fs.dirs.set(path, path)
    const commit = vi.fn(async (ops: V2CommitOp[]): Promise<CommitOpResult[]> => {
      const op = ops[0]!
      if (op.op !== 'mkdir') throw new Error('unexpected operation')
      if (op.path === 'blocked') return [{ status: 'rejected', code, message: 'directory refused' }]
      return [
        {
          status: 'applied',
          file_id: op.path,
          version_id: 'v1',
          seq: 1,
          path: op.path,
          sha: null,
          size: 0,
          mtime: 1,
        },
      ]
    })
    const make = () => new V2Directories(fs, state, () => true, commit)
    await expect(make().scan()).resolves.toBeUndefined()
    await expect(make().scan()).resolves.toBeUndefined()
    expect(commit.mock.calls.map(([ops]) => ops[0])).toEqual([
      { op: 'mkdir', path: 'blocked', mtime: 1 },
      { op: 'mkdir', path: 'allowed', mtime: 1 },
    ])
    expect(JSON.parse((await state.getMeta('v2-directories'))!).refused).toEqual([
      expect.objectContaining({ path: 'blocked', code, message: 'directory refused' }),
    ])
    expect(JSON.parse((await state.getMeta('v2-directories'))!).pending).toBeUndefined()
  }
)

it.each(['envelope', 'result'] as const)(
  'sync reports refused directories and files and continues without repeated requests (%s)',
  async (form) => {
    const fs = new DirectoryFs(),
      state = new MemoryStateStore()
    for (const path of ['blocked', 'blocked/child', 'allowed', 'blocked-other'])
      fs.dirs.set(path, path)
    for (const path of [
      'blocked/a.md',
      'blocked/child/b.md',
      'allowed/c.md',
      'root.md',
      'blocked-other/c.md',
    ])
      await fs.writeAtomic(path, new TextEncoder().encode(path), 1)
    await state.setCursor(1)
    let head = 1,
      refusing = true
    const submitted: V2CommitOp[] = [],
      uploads: string[] = []
    const scope = { kind: 'folder' as const, id: 'root', path: '/' }
    const make = () => {
      const client = new V2EngineClient(
        encodeAccessToken({
          v: 1,
          address: 'https://example.test',
          key: 'k'.repeat(43),
          scope,
        }),
        {
          fetch: async (url, init) => {
            const path = new URL(String(url)).pathname
            if (path === '/v2/connection')
              return Response.json({
                protocol: 2,
                token_id: 'token',
                space_id: 'space',
                scope,
                status: 'active',
                limits: { max_file_bytes: 10000, quota_bytes: null },
              })
            if (path === '/v2/manifest' || path === '/v2/changes')
              return Response.json({ items: [], cursor: head, next: null })
            if (path !== '/v2/commit') throw new Error(`unexpected ${path}`)
            const { ops } = JSON.parse(String(init?.body)) as { ops: V2CommitOp[] }
            submitted.push(...ops)
            if (refusing && ops.some((op) => op.op === 'mkdir' && op.path === 'blocked')) {
              if (form === 'envelope')
                return Response.json(
                  {
                    error: { code: 'quota_exceeded', message: 'directory quota' },
                  },
                  { status: 413 }
                )
              return Response.json({
                cursor: head,
                results: [{ status: 'rejected', code: 'leaves_scope', message: 'directory scope' }],
              })
            }
            return Response.json({
              cursor: head + ops.length,
              results: ops.map((op) => {
                if (op.op !== 'mkdir' && op.op !== 'create') throw new Error('unexpected operation')
                return {
                  status: 'applied',
                  file_id: op.path,
                  version_id: `v${++head}`,
                  seq: head,
                  path: op.path,
                  sha: op.op === 'create' ? op.sha : null,
                  size: op.op === 'create' ? op.size : 0,
                  mtime: op.mtime ?? 1,
                }
              }),
            })
          },
        }
      )
      client.putBlob = async (sha) => {
        uploads.push(sha)
      }
      client.putBlobSource = async (expected, source) => {
        try {
          uploads.push(expected.sha)
        } finally {
          await source.close()
        }
      }
      return new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
    }
    const first = make()
    try {
      const report = await first.sync()
      expect(report.push.rejected.map(({ op }) => ('path' in op ? op.path : null))).toEqual(
        expect.arrayContaining(['blocked', 'blocked/a.md', 'blocked/child/b.md'])
      )
      expect(await state.get('allowed/c.md')).not.toBeNull()
      expect(await state.get('root.md')).not.toBeNull()
      expect(await state.get('blocked-other/c.md')).not.toBeNull()
      expect(await state.get('blocked/a.md')).toBeNull()
      expect(uploads).not.toContain(await sha256(new TextEncoder().encode('blocked/a.md')))
      expect(submitted.filter((op) => op.op === 'mkdir').map((op) => op.path)).toEqual([
        'blocked',
        'allowed',
        'blocked-other',
      ])
      const count = submitted.length
      await first.sync()
      expect(submitted).toHaveLength(count)
      await first.stop()
      const restarted = make()
      try {
        const again = await restarted.sync()
        expect(again.push.rejected).toHaveLength(3)
        expect(submitted).toHaveLength(count)
        refusing = false
        const retried = await restarted.rescan()
        expect(retried.push.rejected).toEqual([])
        expect(await state.get('blocked/a.md')).not.toBeNull()
        expect(await state.get('blocked/child/b.md')).not.toBeNull()
      } finally {
        await restarted.stop()
      }
    } finally {
      await first.stop()
    }
  }
)

it.each([
  new EngineError('io', 'EIO'),
  new AbeleError('internal', 'storage failure'),
  new AbeleError('unauthorized', 'revoked'),
  new AbeleError('forbidden', 'not authorized'),
  new AbeleError('rate_limited', 'try later'),
  new AbeleError('quota_waiting', 'temporary'),
])('keeps directory publication failures retryable: %s', async (error) => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  fs.dirs.set('folder', 'folder')
  const commit = vi.fn(async (): Promise<CommitOpResult[]> => {
    throw error
  })
  const dirs = new V2Directories(fs, state, () => true, commit)
  await expect(dirs.scan()).rejects.toBe(error)
  const pending = JSON.parse((await state.getMeta('v2-directories'))!).pending
  expect(pending.op).toMatchObject({ op: 'mkdir', path: 'folder' })
  await expect(dirs.scan()).rejects.toBe(error)
  expect(JSON.parse((await state.getMeta('v2-directories'))!).pending).toEqual(pending)
  expect(commit).toHaveBeenCalledTimes(2)
})

it.each(['quota_exceeded', 'leaves_scope', 'forbidden'] as const)(
  'a host mkdir refusal (%s) skips remote descendants without content GETs, survives restart, and retries explicitly',
  async (code) => {
    const fs = new DirectoryFs(),
      state = new MemoryStateStore(),
      bytes = new Uint8Array([7])
    const mkdir = fs.mkdir.bind(fs)
    let refusing = true
    const attempts: string[] = [],
      downloads: string[] = []
    fs.mkdir = async (path) => {
      attempts.push(path)
      if (refusing && path === 'blocked') throw new AbeleError(code, 'host directory policy')
      await mkdir(path)
    }
    const sha = await sha256(bytes)
    const scope = { kind: 'folder' as const, id: 'root', path: '/' }
    const make = () =>
      new V2EngineClient(
        encodeAccessToken({
          v: 1,
          address: 'https://example.test',
          key: 'k'.repeat(43),
          scope,
        }),
        {
          fetch: async (url) => {
            const path = new URL(String(url)).pathname
            if (path === '/v2/connection')
              return Response.json({
                protocol: 2,
                token_id: 'token',
                space_id: 'space',
                scope,
                status: 'active',
                limits: { max_file_bytes: 10000, quota_bytes: null },
              })
            if (path === '/v2/changes') return Response.json({ items: [], cursor: 3, next: null })
            if (path === '/v2/manifest')
              return Response.json({
                cursor: 3,
                next: null,
                items: [
                  {
                    kind: 'directory',
                    path: 'blocked',
                    file_id: 'dir',
                    version_id: 'd1',
                    mtime: 1,
                  },
                  ...['blocked/a.md', 'blocked/child/b.md', 'allowed.md'].map((path) => ({
                    kind: 'note',
                    path,
                    file_id: path,
                    version_id: 'v1',
                    mtime: 1,
                    size: 1,
                    sha,
                  })),
                ],
              })
            downloads.push(path)
            return new Response(bytes)
          },
        }
      )
    const options = {
      expected: new ExpectedWrites(),
      dirty: new Set<string>(),
      filter: { excluded: () => false },
    }
    let client = make()
    await client.prepare(fs, state)
    const report = await pull(client, fs, state, options)
    expect(report.rejected?.map((item) => item.change.path)).toEqual([
      'blocked/a.md',
      'blocked/child/b.md',
    ])
    expect(await fs.read('allowed.md')).toEqual(bytes)
    expect(await fs.stat('blocked/a.md')).toBeNull()
    expect(downloads).toHaveLength(1)
    expect(await state.getCursor()).toBe(3)
    client = make()
    await client.prepare(fs, state)
    await pull(client, fs, state, options)
    await client.syncDirectories()
    expect(attempts).toEqual(['blocked'])
    expect(downloads).toHaveLength(1)
    refusing = false
    const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
    const setMeta = state.setMeta.bind(state)
    let crashed = false
    state.setMeta = async (key, value) => {
      const before = await state.getMeta(key)
      await setMeta(key, value)
      if (
        key === 'v2-directories' &&
        before &&
        value &&
        JSON.parse(before).refused?.length &&
        !JSON.parse(value).refused?.length
      ) {
        crashed = true
        throw new EngineError('io', 'crash after retiring directory refusal')
      }
    }
    try {
      await expect(engine.rescan()).rejects.toThrow('crash after retiring directory refusal')
      expect(crashed).toBe(true)
    } finally {
      state.setMeta = setMeta
      await engine.stop()
    }
    const recovered = new SyncEngine({ fs, state, client: make(), selective: selectiveDefaults() })
    try {
      await recovered.sync()
      expect(await fs.read('blocked/a.md')).toEqual(bytes)
      expect(await fs.read('blocked/child/b.md')).toEqual(bytes)
    } finally {
      await recovered.stop()
    }
  }
)

it.each([
  new EngineError('io', 'EIO'),
  Object.assign(new Error('permission denied'), { code: 'EACCES' }),
  new EngineError('lost', 'claim revoked'),
])(
  'host mkdir operational failures abort before the cursor passes remote files: %s',
  async (error) => {
    const fs = new DirectoryFs(),
      state = new MemoryStateStore()
    fs.mkdir = async () => {
      throw error
    }
    const dirs = new V2Directories(
      fs,
      state,
      () => true,
      async () => []
    )
    await expect(
      dirs.receive({
        kind: 'directory',
        path: 'folder',
        file_id: 'dir',
        version_id: 'v1',
        mtime: 1,
      })
    ).rejects.toBe(error)
    expect(await state.getCursor()).toBe(0)
    expect(await state.getMeta('v2-directories')).toBeNull()
  }
)

it('retires a refused local directory once it and its files are gone', async () => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  fs.dirs.set('blocked', 'blocked')
  const commit = vi.fn(async (): Promise<CommitOpResult[]> => [
    {
      status: 'rejected',
      code: 'quota_exceeded',
      message: 'directory quota',
    },
  ])
  const dirs = new V2Directories(fs, state, () => true, commit)
  await dirs.scan()
  expect(dirs.refusals()).toHaveLength(1)
  fs.dirs.delete('blocked')
  await dirs.scan()
  expect(dirs.refusals()).toEqual([])
  expect(commit).toHaveBeenCalledTimes(1)
})

it('retires a host refusal when the corresponding remote directory departs', async () => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  fs.mkdir = async () => {
    throw new AbeleError('leaves_scope', 'host policy')
  }
  const dirs = new V2Directories(
    fs,
    state,
    () => true,
    async () => []
  )
  await dirs.receive({
    kind: 'directory',
    path: 'blocked',
    file_id: 'dir',
    version_id: 'v1',
    mtime: 1,
  })
  expect(dirs.refusals()).toHaveLength(1)
  await dirs.departed('dir')
  expect(dirs.refusals()).toEqual([])
  expect(JSON.parse((await state.getMeta('v2-directories'))!).incoming).toEqual([])
})

it('keeps a refusal attached to a replacement directory when the old identity departs', async () => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  const mkdir = vi.fn(async () => {
    throw new AbeleError('leaves_scope', 'host policy')
  })
  fs.mkdir = mkdir
  const dirs = new V2Directories(
    fs,
    state,
    () => true,
    async () => []
  )
  for (const file_id of ['old', 'replacement'])
    await dirs.receive({ kind: 'directory', path: 'blocked', file_id, version_id: 'v1', mtime: 1 })
  expect(mkdir).toHaveBeenCalledTimes(1)
  await dirs.departed('old')
  expect(dirs.refusals()).toHaveLength(1)
  await dirs.departed('replacement')
  expect(dirs.refusals()).toEqual([])
})

it('replays an uncertain file journal unchanged despite a later refusal of its directory', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore(),
    bytes = new Uint8Array([7])
  await fs.writeAtomic('blocked/a.md', bytes, 1)
  const op = {
    op: 'create' as const,
    path: 'blocked/a.md',
    sha: await sha256(bytes),
    size: 1,
    mtime: 1,
  }
  const journal = {
    batchId: 'batch',
    idempotencyKey: 'original-key',
    ops: [op],
    startedAt: new Date().toISOString(),
  }
  await state.setJournal(journal)
  const commitRaw = vi.fn(async () => ({
    replayed: true,
    body: {
      head_seq: 1,
      results: [
        {
          status: 'applied' as const,
          file_id: 'file',
          version_id: 'v1',
          seq: 1,
          path: op.path,
          sha: op.sha,
          size: 1,
          mtime: 1,
        },
      ],
    },
  }))
  const client = {
    pathRefusal: () => ({ code: 'quota_exceeded', message: 'directory quota' }),
    hasBlob: async () => true,
    commitRaw,
  } as unknown as EngineClient
  const report = await resumeJournal(client, fs, state, { expected: new ExpectedWrites() })
  expect(commitRaw).toHaveBeenCalledWith([op], 'original-key')
  expect(report?.applied).toBe(1)
  expect(await state.get(op.path)).toMatchObject({ fileId: 'file', versionId: 'v1' })
  expect(await state.getJournal()).toBeNull()
})

it.each(['tracked', 'previous'] as const)(
  'D-202 ordinary pull protects held sources (%s)',
  async (source) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new Uint8Array([1]),
      sha = await sha256(bytes)
    const from = source === 'tracked' ? 'blocked/main.js' : 'other/main.js'
    const base = {
      fileId: 'code',
      versionId: 'v1',
      path: from,
      wirePath: from,
      sha,
      size: 1,
      mtime: 1,
    }
    await fs.writeAtomic(from, bytes, 1)
    await state.put(base)
    await state.setCursor(1)
    const change: ChangeItem = {
      seq: 2,
      file_id: 'code',
      version_id: 'v2',
      path: 'free/main.js',
      prev_path: source === 'previous' ? 'blocked/main.js' : null,
      kind: 'attachment',
      op: 'move',
      sha,
      size: 1,
      mtime: 1,
      actor: { kind: 'system', id: 'test', name: 'test' },
      at: '',
    }
    let refusing = true
    const client = {
      changes: async () => ({ items: [change], next_since: 2, head_seq: 2 }),
      pathRefusal: (path: string) =>
        refusing && path.startsWith('blocked/')
          ? { code: 'conflict', message: 'held source' }
          : undefined,
      getBlob: vi.fn(async () => bytes),
    } as unknown as EngineClient
    const options = {
      expected: new ExpectedWrites(),
      dirty: new Set<string>(),
      filter: { excluded: () => false },
    }
    const result = await pull(client, fs, state, options)
    expect(result.applied).toBe(0)
    expect(result.rejected?.map((row) => row.change)).toEqual([change])
    expect(await fs.read(from)).toEqual(bytes)
    expect(await fs.stat(change.path)).toBeNull()
    expect(await state.byFileId('code')).toEqual(base)
    expect(client.getBlob).not.toHaveBeenCalled()
    refusing = false
    const retried = await pull(client, fs, state, options)
    expect(retried.applied).toBe(1)
    expect(await fs.read(change.path)).toEqual(bytes)
  }
)

it.each([false, true])('D-008 preserves excluded empty directories (queued=%s)', async (queued) => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  fs.dirs.set('excluded', 'identity')
  const remove = vi.fn(async (path: string) => {
    fs.dirs.delete(path)
  })
  Object.assign(fs, { removeDirectory: remove })
  const directory = {
    kind: 'directory',
    path: 'excluded',
    localPath: 'excluded',
    identity: 'identity',
    file_id: 'dir',
    version_id: 'v1',
    mtime: 1,
  }
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: queued ? [] : [directory],
      removals: queued ? [{ path: 'excluded', localPath: 'excluded', identity: 'identity' }] : [],
    })
  )
  const dirs = new V2Directories(fs, state, () => false, vi.fn())
  if (!queued) expect(await dirs.departed('dir')).toBe(false)
  await dirs.finishPull()
  expect(remove).not.toHaveBeenCalled()
  expect(fs.dirs.get('excluded')).toBe('identity')
  if (!queued)
    expect(JSON.parse((await state.getMeta('v2-directories'))!).directories).toEqual([directory])
})
