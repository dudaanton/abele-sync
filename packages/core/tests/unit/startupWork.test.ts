import { expect, it } from 'vitest'
import { SyncEngine } from '../../src/engine.js'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { selectiveDefaults } from '../../src/selective.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'
import { scan } from '../../src/scanner.js'
import { encodeAccessToken } from '@abele/sync-protocol'
import { V2EngineClient } from '../../src/v2Client.js'
import { reconciliationScan } from '../../src/reconciliation.js'

it('full revalidation ignores persisted hints after a same-stat edit', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const original = new Uint8Array([1])
  await fs.writeAtomic('file.md', original, 1)
  await state.put({
    path: 'file.md',
    wirePath: 'file.md',
    fileId: 'file',
    versionId: 'v1',
    sha: await sha256(original),
    size: 1,
    mtime: 1,
  })
  const options = { persistHints: true, revalidate: 'all' as const }
  const first = await scan(fs, state, { excluded: () => false }, options)
  expect(first.ops).toHaveLength(0)
  await fs.writeAtomic('file.md', new Uint8Array([2]), 1)
  const resumed = await scan(fs, state, { excluded: () => false }, options)
  expect(resumed.ops).toHaveLength(1)
  expect(resumed.hashes.get('file.md')).toBe(await sha256(new Uint8Array([2])))
})

it('D-031 hands rounded-metadata edits from preflight to the final scan without hashing twice', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await state.put({
    path: 'file.md',
    wirePath: 'file.md',
    fileId: 'file',
    versionId: 'v1',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
  })
  await fs.writeAtomic('file.md', new Uint8Array([2]), 1)
  let reads = 0
  const read = fs.read.bind(fs)
  fs.read = async (path) => {
    reads++
    return read(path)
  }
  const inspected = await reconciliationScan(fs, state, { excluded: () => false }, 0)
  expect(inspected.found.ops).toHaveLength(1)
  const final = await scan(fs, state, { excluded: () => false }, { known: inspected.found })
  expect(final.ops).toHaveLength(1)
  expect(reads).toBe(1)
})

it('D-031 preflight reuses unchanged hints outside its bounded content sweep', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const old = new Uint8Array([1]),
    changed = new Uint8Array([2]),
    sha = await sha256(old)
  for (let n = 0; n < 40; n++) {
    const path = `${n}.md`
    await state.put({
      path,
      wirePath: path,
      fileId: `f${n}`,
      versionId: `v${n}`,
      sha,
      size: 1,
      mtime: 1,
    })
    await fs.writeAtomic(path, changed, 2)
  }
  await state.setCursor(1)
  await scan(fs, state, { excluded: () => false }, { persistHints: true })
  let reads = 0
  const read = fs.read.bind(fs)
  fs.read = async (path) => {
    reads++
    return read(path)
  }
  const inspected = await reconciliationScan(fs, state, { excluded: () => false }, 1)
  expect(inspected.found.ops).toHaveLength(40)
  expect(reads).toBe(16)
})

it('D-031 reuses persisted group eligibility fingerprints after client reconstruction', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await fs.writeAtomic('Root.md', new TextEncoder().encode('root'), 1)
  const scope = { kind: 'group' as const, id: 'root', path: 'Root.md' }
  const make = () =>
    new V2EngineClient(
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
  await make().prepare(fs, state)
  let reads = 0
  const read = fs.read.bind(fs)
  fs.read = async (path) => {
    reads++
    return read(path)
  }
  await make().prepare(fs, state)
  expect(reads).toBe(0)
})

it('D-031 interrupts local scanning for a newly announced remote change', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  for (let n = 0; n < 3; n++) await fs.writeAtomic(`${n}.md`, new Uint8Array([n]), 1)
  await state.setCursor(1)
  let announce!: (seq: number) => void,
    enter!: () => void,
    release!: () => void,
    received!: () => void
  const entered = new Promise<void>((resolve) => {
      enter = resolve
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    applied = new Promise<void>((resolve) => {
      received = resolve
    })
  const bytes = new Uint8Array([8]),
    sha = await sha256(bytes),
    read = fs.read.bind(fs),
    write = fs.conditionalFile.bind(fs)
  let reads = 0,
    head = 1,
    beforeRemote = 0
  fs.read = async (path) => {
    if (path !== 'remote.md') {
      reads++
      if (reads === 1) {
        enter()
        await gate
      }
    }
    return read(path)
  }
  const client = {
    subscribe: (onSeq: (seq: number) => void) => {
      announce = onSeq
      return () => {}
    },
    state: async () => ({ head_seq: head, settings: { max_file_bytes: 10000, quota_bytes: null } }),
    changes: async (since: number) => ({
      items:
        head > since
          ? [
              {
                seq: 2,
                file_id: 'remote',
                version_id: 'version',
                op: 'create',
                prev_path: null,
                path: 'remote.md',
                sha,
                size: 1,
                mtime: 1,
                kind: 'note',
                actor: { kind: 'system', id: 'server', name: 'server' },
                at: '',
              },
            ]
          : [],
      next_since: head,
      head_seq: head,
    }),
    getBlob: async () => bytes,
  } as unknown as EngineClient
  const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
  fs.conditionalFile = async (op) => {
    const applied = await write(op)
    if (applied && op.effect.kind === 'write' && op.path === 'remote.md') {
      beforeRemote = reads
      engine.pause()
      received()
    }
    return applied
  }
  engine.start()
  await entered
  head = 2
  announce(2)
  release()
  await applied
  expect(beforeRemote).toBe(1)
  await engine.stop()
})

it('D-031 applies incoming work before listing or hashing the unrelated local vault', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([3]),
    sha = await sha256(bytes)
  let received = false,
    listings = 0
  const list = fs.list.bind(fs),
    write = fs.conditionalFile!.bind(fs)
  fs.list = async function* () {
    listings++
    if (!received) throw new Error('full inventory blocks remote work')
    yield* list()
  }
  fs.listChildren = async () => []
  fs.conditionalFile = async (op) => {
    const applied = await write(op)
    if (applied && op.effect.kind === 'write') received = true
    return applied
  }
  const item = {
    seq: 1,
    file_id: 'remote',
    version_id: 'version',
    path: 'remote.md',
    sha,
    size: 1,
    mtime: 1,
    kind: 'note',
  }
  const client = {
    state: async () => ({ head_seq: 1, settings: { max_file_bytes: 10000, quota_bytes: null } }),
    manifest: async () => ({ items: [item], head_seq: 1, next: null }),
    changes: async () => ({ items: [], next_since: 1, head_seq: 1 }),
    getBlob: async () => bytes,
  } as unknown as EngineClient
  const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
  await engine.sync()
  expect(received).toBe(true)
  expect(listings).toBe(1)
  await engine.stop()
})

it('D-031 reuses persisted hashes of unchanged unuploaded files after an interrupted scan', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  for (let n = 0; n < 3; n++) await fs.writeAtomic(`${n}.md`, new Uint8Array([n]), 1)
  const controller = new AbortController(),
    read = fs.read.bind(fs)
  let reads = 0
  fs.read = async (path) => {
    if (++reads === 2) controller.abort()
    return read(path)
  }
  await expect(
    scan(fs, state, { excluded: () => false }, { persistHints: true, signal: controller.signal })
  ).rejects.toThrow()
  reads = 0
  fs.read = async (path) => {
    reads++
    return read(path)
  }
  const result = await scan(fs, state, { excluded: () => false }, { persistHints: true })
  expect(result.ops).toHaveLength(3)
  expect(reads).toBe(1)
})
