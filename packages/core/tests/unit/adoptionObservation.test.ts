import { expect, it } from 'vitest'
import {
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  pull,
  scan,
  push,
  sha256,
  type EngineClient,
} from '../../src/index.js'

async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = ['sample A', 'sample B', 'sample C'].map((s) => new TextEncoder().encode(s))
  const hashes = await Promise.all(bytes.map(sha256))
  const base = {
    path: 'old.md',
    wirePath: 'old.md',
    fileId: 'sample',
    versionId: 'a',
    sha: hashes[0]!,
    size: 8,
    mtime: 1000,
  }
  await fs.writeAtomic(base.path, bytes[0]!, 1000)
  await state.put(base)
  await state.setCursor(1)
  await fs.move(base.path, 'Moved/new.md')
  const change = (seq: number, index = seq - 1) => ({
    seq,
    file_id: 'sample',
    version_id: seq === 2 ? 'b' : 'c',
    path: 'Moved/new.md',
    prev_path: seq === 2 ? 'old.md' : null,
    op: seq === 2 ? ('move' as const) : ('modify' as const),
    kind: 'note' as const,
    sha: hashes[index]!,
    size: 8,
    mtime: 1000,
    at: '',
    actor: { kind: 'system' as const, id: 'sample', name: 'Sample' },
  })
  const client = {
    changes: async (since: number) => ({
      items: since < 3 ? [change(since + 1)] : [],
      head_seq: 3,
      next_since: Math.min(3, since + 1),
    }),
    getBlob: async (sha: string) => bytes[hashes.indexOf(sha)]!,
    openVersion: async (_id: string, version: string) => {
      const value = bytes[version === 'b' ? 1 : 2]!
      return {
        size: value.length,
        read: async (at: number, n: number) => value.slice(at, at + n),
        assertUnchanged: async () => {},
        close: async () => {},
      }
    },
  } as unknown as EngineClient
  const run = () =>
    pull(client, fs, state, {
      dirty: new Set(),
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    })
  return { fs, state, bytes, hashes, base, client, change, run }
}

it.each([1, 2, 3, 4, 5, 6])(
  'retains a same-stat save during ordered adoption read %i',
  async (cut) => {
    const f = await fixture(),
      read = f.fs.read.bind(f.fs)
    let reads = 0,
      injected = false
    f.fs.read = async (path) => {
      const data = await read(path)
      if (path === 'Moved/new.md' && ++reads === cut) {
        await f.fs.writeAtomic(path, f.bytes[1]!, 1000)
        injected = true
      }
      return data
    }
    await f.run()
    const visible = []
    for await (const info of f.fs.list()) visible.push(await read(info.path))
    if (injected) expect(visible).toContainEqual(f.bytes[1])
  }
)

it.each([false, true])(
  'holds adoption and uploads a recreated source separately (intermediate=%s)',
  async (intermediate) => {
    const f = await fixture(),
      stat = f.fs.stat.bind(f.fs)
    let injected = false
    f.fs.stat = async (path) => {
      const result = await stat(path)
      if (path === 'old.md' && result === null && !injected) {
        await f.fs.writeAtomic(path, f.bytes[1]!, 1000)
        injected = true
      }
      return result
    }
    f.client.changes = async (since) => ({
      items: since === 1 ? [f.change(2, 0)] : [],
      head_seq: intermediate ? 3 : 2,
      next_since: since === 1 ? 2 : 3,
    })
    const result = await f.run()
    expect(injected).toBe(true)
    expect(await f.fs.read('old.md')).toEqual(f.bytes[1])
    expect(await f.fs.read('Moved/new.md')).toEqual(f.bytes[0])
    expect(await f.state.byFileId('sample')).toEqual(f.base)
    expect(result.held.map((c) => c.file_id)).toContain('sample')
    const found = await scan(f.fs, f.state, { excluded: () => false })
    expect(found.ops).toEqual([
      { op: 'move', file_id: 'sample', base_version_id: 'a', to_path: 'Moved/new.md' },
      { op: 'create', path: 'old.md', sha: f.hashes[1], size: 8, mtime: 1000 },
    ])
    const uploaded: string[] = []
    f.client.hasBlob = async () => false
    f.client.putBlob = async (sha, bytes) => {
      expect(await sha256(bytes)).toBe(sha)
      uploaded.push(sha)
    }
    f.client.commitRaw = async (ops) => ({
      replayed: false,
      body: {
        head_seq: 4,
        results: ops.map((op, i) => ({
          status: 'applied' as const,
          file_id: op.op === 'move' ? 'sample' : 'recreated',
          version_id: `uploaded-${i}`,
          seq: 3 + i,
          path: op.op === 'move' ? op.to_path : 'old.md',
          sha: op.op === 'move' ? f.hashes[0]! : f.hashes[1]!,
          size: 8,
          mtime: 1000,
        })),
      },
    })
    const pushed = await push(f.client, f.fs, f.state, found, { expected: new ExpectedWrites() })
    expect(pushed.kept).toEqual([])
    expect(uploaded).toContain(f.hashes[1])
    expect(await f.state.byFileId('sample')).toMatchObject({
      path: 'Moved/new.md',
      sha: f.hashes[0],
    })
    expect(await f.state.get('old.md')).toMatchObject({ fileId: 'recreated', sha: f.hashes[1] })
    expect(await f.fs.read('old.md')).toEqual(f.bytes[1])
    expect(await f.fs.read('Moved/new.md')).toEqual(f.bytes[0])
  }
)
