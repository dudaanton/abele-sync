import { expect, it, vi } from 'vitest'
import { SyncEngine } from '../../src/engine.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { selectiveDefaults } from '../../src/selective.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'
import { ScopeMarks } from '../../src/scope.js'
import { AbeleError } from '@abele/sync-protocol'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = Array.from({ length: 12 }, (_, n) => new TextEncoder().encode(`file ${n}`))
  const items = await Promise.all(
    bytes.map(async (b, n) => ({
      seq: n + 2,
      file_id: `f${n}`,
      version_id: `v${n}`,
      op: 'create' as const,
      path: `${n}.md`,
      prev_path: null,
      sha: await sha256(b),
      size: b.length,
      mtime: 1,
      kind: 'note' as const,
      actor: { kind: 'system' as const, id: 'test', name: 'test' },
      at: '',
    }))
  )
  const client = {
    state: async () => ({ head_seq: 13, settings: { max_file_bytes: 1e9, quota_bytes: null } }),
    changes: vi.fn(async (since: number) => ({
      items: items.filter((i) => i.seq > since),
      next_since: 13,
      head_seq: 13,
    })),
    manifest: vi.fn(async () => ({ items, next: null, head_seq: 13 })),
    getBlob: vi.fn(async (sha: string) => bytes[items.findIndex((i) => i.sha === sha)]!),
    hasBlob: async () => false,
    putBlob: vi.fn(async () => {}),
    commitRaw: vi.fn(async () => {
      throw new Error('unexpected commit')
    }),
    subscribe: () => () => {},
  } as unknown as EngineClient
  const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
  return { fs, state, client, engine, items, bytes }
}

it('D-022 retains completed manifest coverage when one local edit stays held', async () => {
  const f = await fixture()
  const item = f.items[0]!
  await f.state.put({
    path: item.path,
    wirePath: item.path,
    fileId: item.file_id,
    versionId: 'old',
    sha: item.sha,
    size: item.size,
    mtime: 1,
  })
  await f.fs.writeAtomic('0.md', new TextEncoder().encode('local typing'), 2)
  await f.state.setCursor(13)
  await new ScopeMarks(f.state).review(f.fs, { excluded: () => true })
  f.client.putBlob = async () => {
    throw new AbeleError('too_large', 'held local upload')
  }
  await f.engine.sync()
  await f.engine.sync()
  expect(f.client.manifest).toHaveBeenCalledTimes(1)
  expect(await f.state.getMeta('out-of-scope-files')).toBeNull()
  expect(f.fs.snapshot().size).toBe(12)
  const typing = new TextEncoder().encode('local typing'),
    sha = await sha256(typing)
  f.client.state = async () =>
    ({ head_seq: 14, settings: { max_file_bytes: 1e9, quota_bytes: null } }) as Awaited<
      ReturnType<EngineClient['state']>
    >
  f.client.changes = async (since) => ({
    items:
      since < 14
        ? [
            {
              ...item,
              seq: 14,
              version_id: 'latest',
              sha,
              size: typing.length,
              mtime: 2,
              op: 'modify',
            },
          ]
        : [],
    next_since: 14,
    head_seq: 14,
  })
  await f.engine.sync()
  // An equal intermediate version cannot acknowledge unsent typing. Only a
  // successful publication may establish its clean base before held feed resumes.
  // Completed inventory no longer forces zero: the oldest unresolved change is seq 2.
  expect(await f.state.getCursor()).toBe(1)
  expect(await f.state.get('0.md')).toMatchObject({ versionId: 'old' })
  await f.state.put({
    path: item.path,
    wirePath: item.path,
    fileId: item.file_id,
    versionId: 'acknowledged',
    sha,
    size: typing.length,
    mtime: 2,
  })
  await f.engine.sync()
  expect(await f.state.getCursor()).toBe(14)
  expect(await f.state.getMeta('pull-manifest-progress')).toBeNull()
  expect(await f.state.get('0.md')).toMatchObject({ versionId: 'latest' })
  expect(f.client.manifest).toHaveBeenCalledTimes(1)
  await f.engine.stop()
})

it('D-116 imports a legacy hold before scope widening clears its checkpoint', async () => {
  const f = await fixture()
  const item = { ...f.items[0]!, seq: 50 }
  await f.state.put({
    path: item.path,
    wirePath: item.path,
    fileId: item.file_id,
    versionId: 'base',
    sha: item.sha,
    size: item.size,
    mtime: 1,
  })
  await f.state.setCursor(49)
  await new ScopeMarks(f.state).review(f.fs, { excluded: () => true })
  await f.state.setMeta('held-deletes', JSON.stringify([{ path: item.path, fileId: item.file_id }]))
  await f.state.setMeta(
    'pull-manifest-progress',
    JSON.stringify({
      generation: null,
      scope: 'old',
      head: 100,
      coverageComplete: true,
      firstHeld: null,
      completed: [],
    })
  )
  await f.state.setMeta(
    'pull-manifest-page',
    JSON.stringify({
      items: [],
      next: null,
      head_seq: 100,
      heldChanges: [item],
      recheck: [],
      seen: [],
    })
  )
  f.client.state = async () => ({
    head_seq: 100,
    settings: { max_file_bytes: 1e9, quota_bytes: null },
  })
  f.client.manifest = async () => ({ items: [item], next: null, head_seq: 100 })
  f.client.changes = async () => ({ items: [], next_since: 100, head_seq: 100 })
  f.client.versions = async () =>
    [{ version_id: item.version_id }] as Awaited<ReturnType<EngineClient['versions']>>
  const report = await f.engine.sync()
  expect(report.pull.held.map((c) => c.file_id)).toEqual([item.file_id])
  expect(await f.state.getCursor()).toBeLessThan(50)
  expect(await f.fs.stat(item.path)).toBeNull()
  await f.engine.stop()
})

it('D-035 resumes later manifest pages while unchanged scope recheck marks remain', async () => {
  const f = await fixture()
  await f.fs.writeAtomic('0.md', f.bytes[0]!, 1)
  const item = f.items[0]!
  await f.state.put({
    path: item.path,
    wirePath: item.path,
    fileId: item.file_id,
    versionId: item.version_id,
    sha: item.sha,
    size: item.size,
    mtime: item.mtime,
  })
  await f.state.setCursor(13)
  await new ScopeMarks(f.state).review(f.fs, { excluded: () => true })
  f.client.manifest = vi.fn(async (cursor) => ({
    items: cursor === null ? f.items.slice(0, 4) : f.items.slice(4),
    next: cursor === null ? 'later' : null,
    head_seq: 13,
  }))
  const write = f.fs.conditionalFile.bind(f.fs)
  let paused = false
  f.fs.conditionalFile = async (...args) => {
    const done = await write(...args)
    if (args[0].path === '4.md' && !paused) {
      paused = true
      f.engine.pause()
    }
    return done
  }
  await expect(f.engine.sync()).rejects.toMatchObject({ code: 'offline' })
  expect(await f.state.getMeta('pull-manifest-progress')).not.toBeNull()
  await f.engine.sync()
  expect(
    vi.mocked(f.client.manifest).mock.calls.filter(([cursor]) => cursor === null)
  ).toHaveLength(1)
  expect(f.fs.snapshot().size).toBe(12)
  expect(await f.state.getMeta('out-of-scope-files')).toBeNull()
  await f.engine.stop()
})

for (const verb of ['pause', 'stop'] as const) {
  it(`${verb} stops between pull files and resumes without downloading completed files`, async () => {
    const f = await fixture()
    await f.state.setCursor(1)
    const entered = gate(),
      release = gate()
    const write = f.fs.conditionalFile.bind(f.fs)
    let writes = 0
    f.fs.conditionalFile = async (...args) => {
      writes++
      const done = await write(...args)
      if (writes === 1) {
        entered.release()
        await release.promise
      }
      return done
    }
    const running = f.engine.sync().catch((e) => e)
    await entered.promise
    const stopping = f.engine[verb]()
    release.release()
    await stopping
    await running
    expect(writes).toBe(1)
    expect(await f.state.getCursor()).toBe(2)
    expect(await f.state.get('0.md')).not.toBeNull()
    expect(f.engine.status.state).toBe('paused')
    const gets = vi.mocked(f.client.getBlob).mock.calls.length
    await f.engine.sync()
    expect(f.fs.snapshot().size).toBe(12)
    expect(vi.mocked(f.client.getBlob).mock.calls.slice(gets).flat()).not.toContain(f.items[0]!.sha)
    await f.engine.stop()
  })
}

it('pause cancels a long scan after the current hash and never starts a push', async () => {
  const f = await fixture()
  await f.state.setCursor(13)
  for (let n = 0; n < 12; n++) await f.fs.writeAtomic(`${n}.md`, f.bytes[n]!, 1)
  const entered = gate(),
    release = gate()
  const read = f.fs.read.bind(f.fs)
  let reads = 0
  f.fs.read = async (path) => {
    reads++
    if (reads === 1) {
      entered.release()
      await release.promise
    }
    return read(path)
  }
  const running = f.engine.sync().catch((e) => e)
  await entered.promise
  f.engine.pause()
  release.release()
  await running
  expect(reads).toBe(1)
  expect(f.client.putBlob).not.toHaveBeenCalled()
  expect(f.engine.status.state).toBe('paused')
  await f.engine.stop()
})

for (const verb of ['pause', 'stop'] as const)
  it(`${verb} at a read-effects page boundary prevents another page or any blob fetch`, async () => {
    const f = await fixture()
    const entered = gate(),
      release = gate()
    Object.defineProperty(f.client, 'readEffects', { value: true })
    f.client.manifest = vi.fn(async (cursor) => {
      entered.release()
      await release.promise
      return { items: cursor ? [] : f.items, next: cursor ? null : 'next', head_seq: 13 }
    })
    const running = f.engine.sync().catch((e) => e)
    await entered.promise
    const stopped = f.engine[verb]()
    release.release()
    await stopped
    await running
    expect(f.client.manifest).toHaveBeenCalledTimes(1)
    expect(f.client.getBlob).not.toHaveBeenCalled()
    expect(f.engine.status.state).toBe('paused')
    await f.engine.stop()
  })

it('pause between upload batches keeps the uncertain receipt key for resume', async () => {
  const f = await fixture()
  await f.state.setCursor(13)
  for (let n = 0; n < 1001; n++)
    await f.fs.writeAtomic(`local-${n}.md`, new TextEncoder().encode(`local ${n}`), 1)
  f.client.hasBlob = async () => true
  const keys: string[] = []
  f.client.commitRaw = vi.fn(async (ops: Parameters<EngineClient['commitRaw']>[0], key: string) => {
    keys.push(key)
    if (keys.length === 1) f.engine.pause()
    return {
      replayed: keys.length === 2,
      body: {
        head_seq: 13,
        results: ops.map((op) => {
          if (op.op !== 'create') throw new Error('expected create')
          return {
            ...op,
            status: 'applied' as const,
            file_id: op.path,
            version_id: `v-${op.path}`,
            seq: 13,
          }
        }),
      },
    }
  })
  await expect(f.engine.sync()).rejects.toMatchObject({ code: 'offline' })
  expect(keys).toHaveLength(1)
  expect((await f.state.getJournal())?.ops).toHaveLength(1000)
  await f.engine.sync()
  expect(keys).toHaveLength(3)
  expect(keys[1]).toBe(keys[0])
  expect(keys[2]).not.toBe(keys[0])
  expect(await f.state.getJournal()).toBeNull()
  let entries = 0
  for await (const _entry of f.state.all()) entries++
  expect(entries).toBe(1001)
  await f.engine.stop()
})

it('resumes an interrupted initial manifest from its durable page checkpoint', async () => {
  const f = await fixture()
  Object.defineProperty(f.client, 'readEffects', { value: true })
  f.client.versionBytes = async (fileId) => f.bytes[Number(fileId.slice(1))]!
  const entered = gate(),
    release = gate()
  const write = f.fs.conditionalFile.bind(f.fs)
  let writes = 0
  f.fs.conditionalFile = async (...args) => {
    const done = await write(...args)
    if (++writes === 1) {
      entered.release()
      await release.promise
    }
    return done
  }
  const running = f.engine.sync().catch((e) => e)
  await entered.promise
  f.engine.pause()
  release.release()
  await running
  expect(writes).toBe(1)
  expect(await f.state.getMeta('pull-manifest-progress')).not.toBeNull()
  const calls = vi.mocked(f.client.manifest).mock.calls.length
  const resumed = new SyncEngine({
    fs: f.fs,
    state: f.state,
    client: f.client,
    selective: selectiveDefaults(),
  })
  await resumed.sync()
  expect(f.client.manifest).toHaveBeenCalledTimes(calls)
  expect(f.client.getBlob).not.toHaveBeenCalled()
  expect(f.fs.snapshot().size).toBe(12)
  expect(await f.state.getCursor()).toBe(13)
  expect(await f.state.getMeta('pull-manifest-progress')).toBeNull()
  await resumed.stop()
  await f.engine.stop()
})

it('pause cancels four slow prefetch lanes, and resume converges with correct bytes', async () => {
  const f = await fixture()
  await f.state.setCursor(1)
  const entered = gate(),
    release = gate()
  let fetches = 0
  const get = f.client.getBlob.bind(f.client)
  f.client.getBlob = vi.fn(async (sha) => {
    if (++fetches === 4) entered.release()
    await release.promise
    return get(sha)
  })
  const run = f.engine.sync().catch((e) => e)
  await entered.promise
  f.engine.pause()
  await run
  expect(fetches).toBe(4)
  expect(f.fs.snapshot().size).toBe(0)
  expect(f.engine.status.state).toBe('paused')
  release.release()
  const finished = gate()
  const unsubscribe = f.engine.onStatus((status) => {
    if (status.state === 'idle' && status.lastSyncAt !== null) finished.release()
  })
  f.engine.resume()
  await finished.promise
  unsubscribe()
  for (let n = 0; n < 12; n++) expect(await f.fs.read(`${n}.md`)).toEqual(f.bytes[n])
  await f.engine.stop()
})

it('pause during a first upload drains at most two lanes, preserves its journal and resumes', async () => {
  const f = await fixture()
  await f.state.setCursor(13)
  for (let n = 0; n < 12; n++) await f.fs.writeAtomic(`${n}.md`, f.bytes[n]!, 1)
  const entered = gate(),
    release = gate()
  let uploads = 0
  const uploaded = new Set<string>()
  f.client.hasBlob = async (sha) => uploaded.has(sha)
  f.client.putBlob = vi.fn(async (sha) => {
    if (++uploads === 2) entered.release()
    await release.promise
    uploaded.add(sha)
  })
  f.client.commitRaw = vi.fn(async (ops: Parameters<EngineClient['commitRaw']>[0]) => ({
    replayed: false,
    body: {
      head_seq: 13,
      results: ops.map((op, n) => {
        if (op.op !== 'create') throw new Error('expected create')
        return {
          status: 'applied' as const,
          ...op,
          file_id: `local${n}`,
          version_id: `local-v${n}`,
          seq: 13,
        }
      }),
    },
  }))
  const running = f.engine.sync().catch((e) => e)
  await entered.promise
  f.engine.pause()
  release.release()
  await running
  expect(uploads).toBe(2)
  expect(f.client.commitRaw).not.toHaveBeenCalled()
  expect(await f.state.getJournal()).not.toBeNull()
  expect(f.engine.status.state).toBe('paused')
  await f.engine.sync()
  expect(await f.state.getJournal()).toBeNull()
  expect(f.client.commitRaw).toHaveBeenCalledTimes(1)
  expect(uploads).toBe(12)
  await f.engine.stop()
})
