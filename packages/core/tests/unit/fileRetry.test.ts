import { expect, it, vi } from 'vitest'
import { AbeleError } from '@abele/sync-protocol'
import { SyncEngine, retryPathsCapability } from '../../src/engine.js'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { selectiveDefaults } from '../../src/selective.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'
import { FileRetries, fileErrors, FileOperationError } from '../../src/fileRetry.js'
import { EngineError } from '../../src/errors.js'

it('tags native fingerprint and wrapped read errors but preserves state callback failures', async () => {
  const fs: FileSystem = new MemoryFileSystem()
  const io = Object.assign(new Error('disk unavailable'), { code: 'EIO' })
  fs.read = async () => {
    throw new EngineError('io', 'read failed', io)
  }
  fs.fingerprint = async () => {
    throw io
  }
  fs.fileIdentity = async () => {
    throw io
  }
  fs.beginAtomicWrite = async (_path, _mtime, _base, beforeCreate) => {
    await beforeCreate?.('stage')
    throw new Error('unreachable')
  }
  const wrapped = fileErrors(fs)
  await expect(wrapped.read('file.bin')).rejects.toBeInstanceOf(FileOperationError)
  await expect(wrapped.fingerprint!('file.bin')).rejects.toBeInstanceOf(FileOperationError)
  await expect(wrapped.fileIdentity!('file.bin')).rejects.toBeInstanceOf(FileOperationError)
  await expect(
    wrapped.beginAtomicWrite!('file.bin', 1, null, async () => {
      throw io
    })
  ).rejects.toBe(io)
})
import { Wake } from '../../src/wake.js'
import { scan } from '../../src/scanner.js'

it('schedules a waiting-file retry and cancels that wake when paused', async () => {
  vi.useFakeTimers()
  try {
    const trigger = vi.fn()
    const wake = new Wake({
      client: {} as EngineClient,
      log: () => {},
      backoffMs: [1000, 60000],
      fallbackMs: 60000,
      live: () => true,
      trigger,
      onSeq: () => {},
    })
    wake.scheduleFiles(5000)
    await vi.advanceTimersByTimeAsync(4999)
    expect(trigger).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(trigger).toHaveBeenCalledWith('waiting files')
    wake.scheduleFiles(10000)
    wake.clearTimers()
    await vi.advanceTimersByTimeAsync(10000)
    expect(trigger).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps malformed scheduling metadata visible without blocking valid rows', async () => {
  const state = new MemoryStateStore()
  await state.setMeta('file-retry:broken.bin', '{broken')
  const retries = new FileRetries(
    state,
    () => 0,
    () => {}
  )
  await retries.failed('healthy.bin', 'scan', new Error('try later'))
  await retries.load()
  expect(retries.list()).toHaveLength(2)
  expect(retries.list().find((row) => row.path === 'broken.bin')).toMatchObject({
    quarantined: true,
  })
  expect(await state.getMeta('file-retry:broken.bin')).toBe('{broken')
  await retries.retryNow()
  expect(retries.list().map((row) => row.path)).toEqual(['healthy.bin'])
  expect(await state.getMeta('file-retry-review:broken.bin')).toBe('{broken')
  expect(await state.getMeta('file-retry:broken.bin')).toBeNull()
})

it('persists 5-second exponential backoff capped at five minutes, including subtree waits', async () => {
  const state = new MemoryStateStore()
  let now = 0
  let retries = new FileRetries(
    state,
    () => now,
    () => {}
  )
  for (const delay of [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
    await retries.failed('folder', 'push', new Error('refused'))
    expect(await retries.next()).toBe(now + delay)
    expect(retries.ready('folder/file.bin')).toBe(false)
    retries = new FileRetries(
      state,
      () => now,
      () => {}
    )
    await retries.load()
    now += delay
    expect(retries.ready('folder/file.bin')).toBe(true)
  }
})

it('new server policy invalidates only server refusal backoff across restart', async () => {
  const state = new MemoryStateStore()
  const make = () =>
    new FileRetries(
      state,
      () => 100,
      () => {}
    )
  let retries = make()
  await retries.refreshServerPolicy('cap=4', 10)
  await retries.failed('big.bin', 'push', new Error('too_large: cap'))
  await retries.failed('local.bin', 'push', new FileOperationError('local.bin', new Error('EIO')))
  retries = make()
  await retries.load()
  await retries.refreshServerPolicy('cap=4', 10)
  expect(retries.ready('big.bin', 'push')).toBe(false)
  await retries.refreshServerPolicy('cap=40', 10)
  expect(retries.ready('big.bin', 'push')).toBe(true)
  expect(retries.ready('local.bin', 'push')).toBe(false)
})

it('new membership and released uncommitted uploads need not wait for the retry timer', async () => {
  const state = new MemoryStateStore()
  const retries = new FileRetries(
    state,
    () => 100,
    () => {}
  )
  await retries.refreshServerPolicy('same', 10)
  await retries.failed('child.md', 'push', new Error('leaves_scope: parent not uploaded'))
  await retries.failed('member.md', 'push', new Error('forbidden: not in group yet'))
  await retries.failed('waiting.bin', 'push', new Error('quota_waiting: uncommitted uploads'))
  await retries.refreshServerPolicy('same', 10)
  expect(retries.ready('child.md', 'push')).toBe(false)
  expect(retries.ready('member.md', 'push')).toBe(false)
  expect(retries.ready('waiting.bin', 'push')).toBe(true)
  await retries.refreshServerPolicy('same', 11)
  expect(retries.ready('child.md', 'push')).toBe(true)
  expect(retries.ready('member.md', 'push')).toBe(true)
})

it('quarantines only the recovery record after three failed attempts', async () => {
  const state = new MemoryStateStore()
  let now = 0
  const retries = new FileRetries(
    state,
    () => now,
    () => {}
  )
  for (let n = 0; n < 3; n++) {
    await retries.failed('broken.bin', 'recovery', new Error('record cannot settle'))
    now += 300000
  }
  expect(retries.ready('broken.bin')).toBe(false)
  expect(retries.ready('healthy.bin')).toBe(true)
  expect(await retries.next()).toBeNull()
  await retries.retryNow()
  expect(retries.ready('broken.bin')).toBe(true)
})

it('does not infer a delete from an absent file awaiting recovery', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await state.put({
    path: 'hidden.bin',
    wirePath: 'hidden.bin',
    fileId: 'file',
    versionId: 'v1',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
  })
  const retries = new FileRetries(
    state,
    () => 0,
    () => {}
  )
  await retries.failed('hidden.bin', 'recovery', new Error('pending installation'), true)
  const result = await scan(fs, state, { excluded: () => false }, { retries })
  expect(result.ops).toEqual([])
})

async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await state.setCursor(1)
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  const items = ['broken.bin', 'healthy.bin'].map((path, n) => ({
    file_id: path,
    version_id: 'v1',
    seq: n + 2,
    path,
    op: 'create' as const,
    prev_path: null,
    sha,
    size: 1,
    mtime: 1,
    kind: 'attachment' as const,
    actor: { kind: 'system' as const, id: 'test', name: 'test' },
    at: '',
  }))
  const client = {
    state: async () => ({ head_seq: 3, settings: { max_file_bytes: 1e9, quota_bytes: null } }),
    changes: async (since: number) => ({
      items: items.filter((i) => i.seq > since),
      next_since: 3,
      head_seq: 3,
    }),
    getBlob: async () => bytes,
    manifest: async () => ({ items, head_seq: 3, next: null }),
    subscribe: () => () => {},
    hasBlob: async () => true,
    commitRaw: async () => {
      throw new Error('unexpected commit')
    },
  } as unknown as EngineClient
  let time = 10000
  const options = { fs, state, client, selective: selectiveDefaults(), now: () => time }
  return {
    fs,
    state,
    client,
    options,
    advance: (ms: number) => {
      time += ms
    },
  }
}

it('selectively retries one refused push even when another path has identical bytes', async () => {
  const f = await fixture()
  f.client.changes = async () => ({ items: [], next_since: 1, head_seq: 1 })
  f.client.state = async () =>
    ({ head_seq: 1, settings: { max_file_bytes: 1e9, quota_bytes: null } }) as Awaited<
      ReturnType<EngineClient['state']>
    >
  for (const path of ['broken.bin', 'healthy.bin'])
    await f.fs.writeAtomic(path, new Uint8Array([2]), 1)
  f.client.hasBlob = async () => false
  const upload = vi.fn(async () => {
    throw new AbeleError('too_large', 'denied')
  })
  f.client.putBlob = upload
  const engine = new SyncEngine(f.options)
  try {
    await engine.sync()
    const before = await f.state.getMeta('file-retry:healthy.bin')
    expect(upload).toHaveBeenCalledTimes(1)
    await engine.retryPaths(['broken.bin'])
    expect(upload).toHaveBeenCalledTimes(2)
    expect(await f.state.getMeta('file-retry:healthy.bin')).toBe(before)
    expect((await engine.waitingFiles()).map((row) => row.path).sort()).toEqual([
      'broken.bin',
      'healthy.bin',
    ])
  } finally {
    await engine.stop()
  }
})

it('resets only exact selected retry schedules and retains durable owners', async () => {
  const state = new MemoryStateStore()
  const retries = new FileRetries(
    state,
    () => 0,
    () => {}
  )
  await retries.failed('folder/a', 'pull', new Error('a'), true)
  await retries.failed('folder/b', 'pull', new Error('b'), true)
  await state.setMeta('pull-refused:a', 'immutable obligation')
  const before = await state.getMeta('file-retry:folder%2Fb')
  await retries.retryPaths(['folder/a'])
  expect(retries.ready('folder/a')).toBe(true)
  expect(retries.ready('folder/b')).toBe(false)
  expect(await state.getMeta('file-retry:folder%2Fb')).toBe(before)
  expect(await state.getMeta('pull-refused:a')).toBe('immutable obligation')
})

it('queues symbol selective retry behind the active run and snapshots caller paths', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const changes = f.client.changes
  let first = true
  f.client.changes = async (...args) => {
    if (first) {
      first = false
      entered()
      await gate
    }
    return changes(...args)
  }
  const retry = vi.fn(async (_paths?: readonly string[]) => {})
  f.client.retryRefusedDirectories = retry
  const engine = new SyncEngine(f.options)
  const running = engine.sync()
  await reached
  const paths = ['broken.bin']
  const selected = engine[retryPathsCapability](paths)
  paths.push('healthy.bin')
  await Promise.resolve()
  expect(retry).not.toHaveBeenCalled()
  release()
  try {
    await running
    await selected
    expect(retry).toHaveBeenCalledExactlyOnceWith(['broken.bin'])
  } finally {
    release()
    await engine.stop()
  }
})

it.each(['EACCES', 'forbidden'])(
  'a refused file write (%s) waits durably while other files converge, then retries explicitly',
  async (code) => {
    const f = await fixture()
    const write = f.fs.conditionalFile.bind(f.fs)
    let broken = true,
      attempts = 0
    f.fs.conditionalFile = async (op) => {
      if (op.path === 'broken.bin') {
        attempts++
        if (broken)
          throw code === 'forbidden'
            ? new AbeleError('forbidden', 'host file policy')
            : Object.assign(new Error('file temporarily locked'), { code })
      }
      return write(op)
    }
    let engine = new SyncEngine(f.options)
    await expect(engine.sync()).resolves.toBeDefined()
    expect(await f.fs.read('healthy.bin')).toEqual(new Uint8Array([1]))
    expect(engine.status.waiting).toBe(1)
    expect(await f.state.getCursor()).toBe(1)
    const first = attempts
    await engine.stop()
    engine = new SyncEngine(f.options)
    await engine.sync()
    expect(attempts).toBe(first)
    f.advance(5000)
    await engine.sync()
    expect(attempts).toBe(first + 1)
    broken = false
    await engine.retryNow()
    expect(await f.fs.read('broken.bin')).toEqual(new Uint8Array([1]))
    expect(engine.status.waiting).toBe(0)
    expect(await f.state.getCursor()).toBe(3)
    await engine.stop()
  }
)

it('a broken recovery record is visible and does not block unrelated incoming files', async () => {
  const f = await fixture()
  await f.state.setMeta('pull-write:damaged', '{broken')
  const engine = new SyncEngine(f.options)
  await expect(engine.sync()).resolves.toBeDefined()
  expect(await f.fs.read('healthy.bin')).toEqual(new Uint8Array([1]))
  expect(engine.status.waiting).toBe(1)
  expect((await engine.waitingFiles())[0]).toMatchObject({ quarantined: true })
  expect(await f.state.getMeta('pull-write:damaged')).toBe('{broken')
  await engine.stop()
})

it('network failure keeps cycle-level failure handling', async () => {
  const f = await fixture()
  f.client.changes = vi.fn(async () => {
    throw new TypeError('network unavailable')
  })
  const engine = new SyncEngine(f.options)
  const retries = new FileRetries(
    f.state,
    () => 0,
    () => {}
  )
  await retries.failed('broken.bin', 'pull', new Error('previous file failure'))
  const schedule = vi.spyOn(Wake.prototype, 'scheduleFiles')
  await expect(engine.sync()).rejects.toThrow('network unavailable')
  expect(engine.status.waiting).toBe(1)
  expect(schedule).toHaveBeenLastCalledWith(null)
  schedule.mockRestore()
  await engine.stop()
})

it('a durable state EIO remains a cycle failure, not a file retry', async () => {
  const f = await fixture()
  f.state.getCursor = async () => {
    throw Object.assign(new Error('database unavailable'), { code: 'EIO' })
  }
  const engine = new SyncEngine(f.options)
  await expect(engine.sync()).rejects.toThrow('database unavailable')
  expect(engine.status.waiting ?? 0).toBe(0)
  await engine.stop()
})

it('a scan read failure waits without preventing a healthy file upload', async () => {
  const f = await fixture()
  f.client.changes = async () => ({ items: [], next_since: 1, head_seq: 1 })
  const originalState = f.client.state
  f.client.state = async () => ({ ...(await originalState()), head_seq: 1 })
  for (const path of ['broken.bin', 'healthy.bin'])
    await f.fs.writeAtomic(path, new Uint8Array([2]), 1)
  const read = f.fs.read.bind(f.fs)
  f.fs.read = async (path) => {
    if (path === 'broken.bin')
      throw Object.assign(new Error('unreadable candidate'), { code: 'EIO' })
    return read(path)
  }
  f.client.commitRaw = async (ops) => ({
    replayed: false,
    body: {
      head_seq: 1,
      results: ops.map((op) => {
        if (op.op !== 'create') throw new Error('expected create')
        return { ...op, status: 'applied' as const, file_id: op.path, version_id: 'v1', seq: 1 }
      }),
    },
  })
  const engine = new SyncEngine(f.options)
  await expect(engine.sync()).resolves.toBeDefined()
  expect(await f.state.get('healthy.bin')).not.toBeNull()
  expect(engine.status.waiting).toBe(1)
  await engine.stop()
})

it('an upload source read failure does not stop the other files in its batch', async () => {
  const f = await fixture()
  f.client.changes = async () => ({ items: [], next_since: 1, head_seq: 1 })
  const originalState = f.client.state
  f.client.state = async () => ({ ...(await originalState()), head_seq: 1 })
  await f.fs.writeAtomic('broken.bin', new Uint8Array([10]), 1)
  await f.fs.writeAtomic('healthy.bin', new Uint8Array([20]), 1)
  let uploading = false
  f.client.hasBlob = async () => {
    uploading = true
    return false
  }
  f.client.putBlob = async () => {}
  const read = f.fs.read.bind(f.fs)
  f.fs.read = async (path) => {
    if (uploading && path === 'broken.bin')
      throw Object.assign(new Error('source read failed'), { code: 'EIO' })
    return read(path)
  }
  f.client.commitRaw = async (ops) => ({
    replayed: false,
    body: {
      head_seq: 1,
      results: ops.map((op) => {
        if (op.op !== 'create') throw new Error('expected create')
        return { ...op, status: 'applied' as const, file_id: op.path, version_id: 'v1', seq: 1 }
      }),
    },
  })
  const engine = new SyncEngine(f.options)
  await expect(engine.sync()).resolves.toBeDefined()
  expect(await f.state.get('healthy.bin')).not.toBeNull()
  expect(await f.state.get('broken.bin')).toBeNull()
  expect(engine.status.waiting).toBe(1)
  expect(await f.state.getJournal()).toBeNull()
  await engine.stop()
})

it('a failed receipt write retains that answer and records the other batch members', async () => {
  const f = await fixture()
  const applied = vi.fn()
  f.client.changes = async () => ({ items: [], next_since: 1, head_seq: 1 })
  const originalState = f.client.state
  f.client.state = async () => ({ ...(await originalState()), head_seq: 1 })
  for (const path of ['broken.bin', 'healthy.bin'])
    await f.fs.writeAtomic(path, new Uint8Array([2]), 1)
  const merged = new Uint8Array([3]),
    sha = await sha256(merged)
  f.client.getBlob = async () => merged
  f.client.commitRaw = vi.fn(async (ops: Parameters<EngineClient['commitRaw']>[0]) => ({
    replayed: false,
    body: {
      head_seq: 1,
      results: ops.map((op) => {
        if (op.op !== 'create') throw new Error('expected create')
        return {
          ...op,
          status: op.path === 'broken.bin' ? ('merged' as const) : ('applied' as const),
          file_id: op.path,
          version_id: 'v1',
          seq: 1,
          sha: op.path === 'broken.bin' ? sha : op.sha,
        }
      }),
    },
  }))
  const write = f.fs.conditionalFile.bind(f.fs)
  let broken = true
  f.fs.conditionalFile = async (op) => {
    if (broken && op.path === 'broken.bin')
      throw Object.assign(new Error('receipt write failed'), { code: 'EIO' })
    return write(op)
  }
  const engine = new SyncEngine({ ...f.options, onApplied: applied })
  await expect(engine.sync()).resolves.toBeDefined()
  expect(await f.state.get('healthy.bin')).not.toBeNull()
  expect(await f.state.get('broken.bin')).toBeNull()
  expect(engine.status.waiting).toBe(1)
  expect(await f.state.getJournal()).toBeNull()
  expect(await f.state.metadataKeys('push-receipt:')).toHaveLength(1)
  broken = false
  await engine.retryNow()
  expect(await f.fs.read('broken.bin')).toEqual(merged)
  expect(await f.state.metadataKeys('push-receipt:')).toEqual([])
  expect(engine.status.waiting).toBe(0)
  expect(f.client.commitRaw).toHaveBeenCalledTimes(1)
  expect(applied.mock.calls.map(([change]) => change.path).sort()).toEqual([
    'broken.bin',
    'healthy.bin',
  ])
  await engine.stop()
})
